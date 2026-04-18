use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256};

pub const PBKDF2_ITERATIONS: u32 = 200_000;
pub const IV_SIZE: usize = 12;
pub const KEY_SIZE: usize = 32;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

pub fn pbkdf2_derive(passphrase: &[u8], salt: &[u8]) -> [u8; KEY_SIZE] {
    let mut key = [0u8; KEY_SIZE];
    pbkdf2_hmac::<sha2::Sha256>(passphrase, salt, PBKDF2_ITERATIONS, &mut key);
    key
}

/// Encrypt plaintext → IV(12) || ciphertext+tag.
pub fn aes_gcm_encrypt(key_bytes: &[u8; KEY_SIZE], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("aes-gcm encrypt: {e}"))?;
    let mut out = Vec::with_capacity(IV_SIZE + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt IV(12) || ciphertext+tag → plaintext.
pub fn aes_gcm_decrypt(key_bytes: &[u8; KEY_SIZE], framed: &[u8]) -> Result<Vec<u8>, String> {
    if framed.len() < IV_SIZE {
        return Err("encrypted chunk too short".into());
    }
    let nonce = Nonce::from_slice(&framed[..IV_SIZE]);
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    cipher
        .decrypt(nonce, &framed[IV_SIZE..])
        .map_err(|e| format!("aes-gcm decrypt: {e}"))
}
