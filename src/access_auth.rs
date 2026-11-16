//! Validate Cloudflare Access's origin JWT, never the opaque Managed OAuth bearer.
//! JWKS must come from the configured Access team origin, not from token jku/x5u.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rsa::{pkcs1v15::VerifyingKey, signature::Verifier, BigUint, RsaPublicKey};
use serde_json::Value;
use sha2::Sha256;

pub struct AccessPolicy<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub subject: &'a str,
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn team_issuer_valid(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let Some(team) = host.strip_suffix(".cloudflareaccess.com") else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/"
        && !team.is_empty()
        && !team.contains('.')
        && team.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
pub fn canonical_host_allowed(request_url: &str, configured_host: &str) -> bool {
    if configured_host.is_empty() || configured_host.ends_with(".workers.dev") {
        return false;
    }
    let Ok(url) = url::Url::parse(request_url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some(configured_host)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}
pub fn validate_access_jwt(
    token: &str,
    jwks: &Value,
    policy: &AccessPolicy<'_>,
    now: u64,
) -> Result<String, &'static str> {
    if token.len() > 16384
        || !team_issuer_valid(policy.issuer)
        || policy.audience.is_empty()
        || policy.subject.is_empty()
    {
        return Err("invalid configuration or token");
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("invalid JWT");
    }
    let decode = |s: &str| -> Result<Value, &'static str> {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(s).map_err(|_| "invalid encoding")?)
            .map_err(|_| "invalid JSON")
    };
    let header = decode(parts[0])?;
    if text(&header, "alg") != "RS256"
        || text(&header, "kid").is_empty()
        || header.get("crit").is_some()
        || header.get("jku").is_some()
        || header.get("x5u").is_some()
    {
        return Err("unsupported JWT header");
    }
    let keys = jwks["keys"].as_array().ok_or("invalid JWKS")?;
    if keys.len() > 16 {
        return Err("too many JWKS keys");
    }
    let matches: Vec<_> = keys
        .iter()
        .filter(|key| text(key, "kid") == text(&header, "kid"))
        .collect();
    if matches.len() != 1 {
        return Err("unknown or duplicate key");
    }
    let key = matches[0];
    if text(key, "kty") != "RSA"
        || key.get("use").is_some_and(|v| v != "sig")
        || key.get("alg").is_some_and(|v| v != "RS256")
    {
        return Err("invalid signing key");
    }
    let n = URL_SAFE_NO_PAD
        .decode(text(key, "n"))
        .map_err(|_| "invalid modulus")?;
    let e = URL_SAFE_NO_PAD
        .decode(text(key, "e"))
        .map_err(|_| "invalid exponent")?;
    if !(256..=512).contains(&n.len()) || e != [1, 0, 1] {
        return Err("unsupported RSA key");
    }
    let public = RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))
        .map_err(|_| "invalid RSA key")?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "invalid signature encoding")?;
    let signature = rsa::pkcs1v15::Signature::try_from(signature.as_slice())
        .map_err(|_| "invalid signature")?;
    VerifyingKey::<Sha256>::new(public)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .map_err(|_| "bad signature")?;
    let claims = decode(parts[1])?;
    if text(&claims, "iss") != policy.issuer
        || text(&claims, "sub") != policy.subject
        || text(&claims, "type") != "app"
    {
        return Err("wrong principal or issuer");
    }
    let aud_ok = claims["aud"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(policy.audience)));
    if !aud_ok {
        return Err("wrong audience");
    }
    let exp = claims["exp"].as_u64().ok_or("missing expiration")?;
    let iat = claims["iat"].as_u64().ok_or("missing issued-at")?;
    if now >= exp
        || iat > now.saturating_add(30)
        || iat >= exp
        || claims
            .get("nbf")
            .is_some_and(|v| v.as_u64().is_none_or(|t| t > now))
    {
        return Err("token outside validity");
    }
    Ok(policy.subject.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_alternate_hosts() {
        assert!(canonical_host_allowed(
            "https://mcp.example.com/mcp",
            "mcp.example.com"
        ));
        assert!(!canonical_host_allowed(
            "https://x.workers.dev/mcp",
            "mcp.example.com"
        ));
        assert!(!canonical_host_allowed(
            "https://x.workers.dev/mcp",
            "x.workers.dev"
        ));
        assert!(!canonical_host_allowed(
            "http://mcp.example.com/mcp",
            "mcp.example.com"
        ));
        assert!(!team_issuer_valid("https://example.com"));
        assert!(!team_issuer_valid("https://a.cloudflareaccess.com.evil"));
        assert!(team_issuer_valid("https://team.cloudflareaccess.com"));
    }
    #[test]
    fn synthetic_signed_access_assertion() {
        let fixture: Value = serde_json::from_str(include_str!("../test/access-jwt.json")).unwrap();
        let policy = AccessPolicy {
            issuer: "https://test.cloudflareaccess.com",
            audience: "fake-app-aud",
            subject: "fake-owner-sub",
        };
        let jwt = fixture["jwt"].as_str().unwrap();
        assert_eq!(
            validate_access_jwt(jwt, &fixture["jwks"], &policy, 1794830400).unwrap(),
            "fake-owner-sub"
        );
        assert!(validate_access_jwt(jwt, &fixture["jwks"], &policy, 1794834000).is_err());
        assert!(validate_access_jwt(
            jwt,
            &fixture["jwks"],
            &AccessPolicy {
                audience: "wrong",
                ..policy
            },
            1794830400
        )
        .is_err());
        let mut segments: Vec<_> = jwt.split('.').map(String::from).collect();
        segments[1] = URL_SAFE_NO_PAD.encode(br#"{"sub":"attacker"}"#);
        assert!(
            validate_access_jwt(&segments.join("."), &fixture["jwks"], &policy, 1794830400)
                .is_err()
        );
    }
}
