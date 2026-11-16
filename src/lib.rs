pub mod access_auth;
pub mod mcp_events;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn valid_id(value: &str) -> bool {
    (17..=20).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_digit())
}
pub fn allowed(list: &str, id: &str) -> bool {
    valid_id(id) && list.split(',').any(|s| s.trim() == id)
}
pub fn bearer_matches(header: &str, token: &str) -> bool {
    if token.len() < 32 || token.starts_with("REPLACE") {
        return false;
    }
    let a = Sha256::digest(header.as_bytes());
    let b = Sha256::digest(format!("Bearer {token}").as_bytes());
    bool::from(a.ct_eq(&b))
}
pub fn verify_signature(
    body: &[u8],
    timestamp: &str,
    signature: &str,
    key: &str,
    now: i64,
) -> bool {
    if timestamp.len() != 10 || !timestamp.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let Ok(ts) = timestamp.parse::<i64>() else {
        return false;
    };
    if now.abs_diff(ts) > 300 {
        return false;
    }
    let Ok(key_bytes) = hex::decode(key) else {
        return false;
    };
    let Ok(key_array) = <[u8; 32]>::try_from(key_bytes) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_array) else {
        return false;
    };
    let Ok(sig) = hex::decode(signature) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig) else {
        return false;
    };
    let mut signed = timestamp.as_bytes().to_vec();
    signed.extend_from_slice(body);
    key.verify_strict(&signed, &sig).is_ok()
}
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    #[test]
    fn id_and_allowlist_fail_closed() {
        assert!(valid_id("123456789012345678"));
        assert!(!valid_id("123"));
        assert!(!allowed("", "123456789012345678"));
        assert!(allowed(
            " 123456789012345678,234567890123456789",
            "123456789012345678"
        ));
    }
    #[test]
    fn bearer_requires_strong_config_and_exact_match() {
        assert!(!bearer_matches("Bearer short", "short"));
        assert!(!bearer_matches(
            "Bearer REPLACE_123456789012345678901234567890",
            "REPLACE_123456789012345678901234567890"
        ));
        let token = "a".repeat(32);
        assert!(bearer_matches(&format!("Bearer {token}"), &token));
        assert!(!bearer_matches(&format!("Bearer {token}x"), &token));
    }
    #[test]
    fn authentic_signature_and_tamper_replay_rejection() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let ts = "1794830400";
        let body = b"{\"type\":1}";
        let mut msg = ts.as_bytes().to_vec();
        msg.extend_from_slice(body);
        let sig = hex::encode(key.sign(&msg).to_bytes());
        assert!(verify_signature(body, ts, &sig, &public, 1794830400));
        assert!(!verify_signature(b"{}", ts, &sig, &public, 1794830400));
        assert!(!verify_signature(body, ts, &sig, &public, 1794830701));
        assert!(!verify_signature(body, ts, "xx", &public, 1794830400));
        assert!(!verify_signature(body, ts, &sig, "xx", 1794830400));
    }
}
