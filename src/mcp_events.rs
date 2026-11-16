//! Offline-tested MCP Events primitives. NOT a network endpoint or OAuth implementation.
//! Callers must authenticate/authorize first, persist state strongly, and use a
//! connection-time IP-validating HTTPS transport. URL checks below do NOT do DNS checks.
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

/// Never Debug/Serialize this type. The secret must not appear in logs or MCP responses.
pub struct SigningSecret(Vec<u8>);
impl SigningSecret {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let encoded = value
            .strip_prefix("whsec_")
            .ok_or("missing secret prefix")?;
        let key = STANDARD
            .decode(encoded)
            .map_err(|_| "invalid secret encoding")?;
        if !(24..=64).contains(&key.len()) {
            return Err("invalid secret length");
        }
        Ok(Self(key))
    }
    pub fn sign(
        &self,
        event_id: &str,
        unix_seconds: u64,
        body: &[u8],
    ) -> Result<String, &'static str> {
        if event_id.is_empty()
            || event_id.len() > 128
            || !event_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("invalid event id");
        }
        if body.len() > 262_144 {
            return Err("payload too large");
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).map_err(|_| "invalid key")?;
        mac.update(format!("{event_id}.{unix_seconds}.").as_bytes());
        mac.update(body);
        Ok(format!(
            "v1,{}",
            STANDARD.encode(mac.finalize().into_bytes())
        ))
    }
}
/// Restricted schemas contain objects, strings, arrays, booleans, null only.
/// Sorting keys is sufficient for our fixed string-valued subscription filter.
fn canonical(value: &Value) -> Result<Value, &'static str> {
    match value {
        Value::Number(_) => Err("numeric subscription arguments unsupported"),
        Value::Object(map) => {
            let ordered: std::collections::BTreeMap<_, _> = map
                .iter()
                .map(|(k, v)| Ok((k.clone(), canonical(v)?)))
                .collect::<Result<_, &'static str>>()?;
            Ok(serde_json::to_value(ordered).map_err(|_| "invalid arguments")?)
        }
        Value::Array(items) => Ok(Value::Array(
            items.iter().map(canonical).collect::<Result<_, _>>()?,
        )),
        other => Ok(other.clone()),
    }
}
pub fn subscription_id(
    issuer: &str,
    subject: &str,
    callback: &str,
    channel_id: &str,
) -> Result<String, &'static str> {
    if issuer.is_empty() || subject.is_empty() || !crate::valid_id(channel_id) {
        return Err("invalid identity");
    }
    // A JSON tuple avoids concatenation ambiguity; identity includes issuer as well as sub.
    let identity = canonical(
        &json!([issuer, subject, callback, "discord.task.created", {"channel_id": channel_id}]),
    )?;
    let bytes = serde_json::to_vec(&identity).map_err(|_| "invalid identity")?;
    Ok(format!("sub_{}", hex::encode(Sha256::digest(bytes))))
}
/// Syntax allowlist only. Does NOT establish SSRF safety or permission to send.
/// No wildcard hosts. The transport must separately resolve, validate and pin public IPs.
pub fn callback_syntax_allowed(raw: &str, exact_hosts: &[&str]) -> bool {
    if raw.len() > 2048 || raw.bytes().any(|b| b <= 32 || b == 127) {
        return false;
    }
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(url.host(), Some(url::Host::Domain(host)) if exact_hosts.contains(&host))
}
pub fn can_deliver(active: bool, expires_at: u64, now: u64, access_allowed: bool) -> bool {
    active && access_allowed && now < expires_at
}
pub fn retryable_status(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secret_and_signature_vector() {
        let secret =
            SigningSecret::parse(&format!("whsec_{}", STANDARD.encode([7u8; 32]))).unwrap();
        assert_eq!(
            secret
                .sign("evt_123", 1794830400, b"{\"ok\":true}")
                .unwrap(),
            "v1,w5PCQj/iwFKsLAjsm2eVKMxnvp4rbr4huu9ceh5fuJk="
        );
        assert!(SigningSecret::parse("whsec_c2hvcnQ=").is_err());
        assert!(SigningSecret::parse("secret").is_err());
        assert!(secret.sign("header\r\ninjection", 1, b"{}").is_err());
        assert!(secret.sign("evt_1", 1, &vec![0; 262_145]).is_err());
    }
    #[test]
    fn identity_is_bound_and_canonical() {
        let args1 = json!({"b": "2", "a": "1"});
        let args2 = json!({"a": "1", "b": "2"});
        assert_eq!(canonical(&args1).unwrap(), canonical(&args2).unwrap());
        assert!(canonical(&json!({"n":1})).is_err());
        let a = subscription_id(
            "https://issuer.example",
            "alice",
            "https://callback.example/1",
            "123456789012345678",
        )
        .unwrap();
        let b = subscription_id(
            "https://issuer.example",
            "bob",
            "https://callback.example/1",
            "123456789012345678",
        )
        .unwrap();
        assert_ne!(a, b);
        assert_eq!(
            a,
            subscription_id(
                "https://issuer.example",
                "alice",
                "https://callback.example/1",
                "123456789012345678"
            )
            .unwrap()
        );
    }
    #[test]
    fn callback_syntax_is_not_a_dns_guarantee() {
        let hosts = ["callback.example"];
        assert!(callback_syntax_allowed(
            "https://callback.example/event?key=x",
            &hosts
        ));
        for url in [
            "http://callback.example/e",
            "https://callback.example.evil/e",
            "https://evil@callback.example/e",
            "https://callback.example:444/e",
            "https://127.0.0.1/e",
            "https://[::1]/e",
            "https://callback.example/e#frag",
            "https://callback.example/\n",
        ] {
            assert!(!callback_syntax_allowed(url, &hosts), "{url}");
        }
    }
    #[test]
    fn expiry_revocation_and_retry_rules() {
        assert!(can_deliver(true, 100, 99, true));
        assert!(!can_deliver(true, 100, 100, true));
        assert!(!can_deliver(false, 100, 99, true));
        assert!(!can_deliver(true, 100, 99, false));
        for status in [200, 301, 401, 403, 410, 413] {
            assert!(!retryable_status(status));
        }
        assert!(retryable_status(429));
        assert!(retryable_status(503));
    }
}
