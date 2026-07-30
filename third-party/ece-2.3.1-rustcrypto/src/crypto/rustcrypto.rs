/* This file is part of rust-ece. Copyright 2020 Mozilla. Licensed under MPL-2.0. */

use crate::{
    crypto::{Cryptographer, EcKeyComponents, LocalKeyPair, RemotePublicKey},
    error::*,
};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes128Gcm, Nonce,
};
use base64::Engine;
use hkdf::Hkdf;
use p256::{ecdh, PublicKey, SecretKey};
use sha2::Sha256;
use std::{any::Any, fmt};

const AES_GCM_TAG_LENGTH: usize = 16;

#[derive(Clone, Debug)]
pub struct RustCryptoRemotePublicKey {
    raw_pub_key: Vec<u8>,
    key: PublicKey,
}

impl RustCryptoRemotePublicKey {
    fn from_raw(raw: &[u8]) -> Result<Self> {
        if raw.len() != 65 || raw[0] != 0x04 {
            return Err(Error::CryptoError);
        }
        let key = PublicKey::from_sec1_bytes(raw).map_err(|_| Error::CryptoError)?;
        Ok(Self {
            raw_pub_key: raw.to_vec(),
            key,
        })
    }
}
impl RemotePublicKey for RustCryptoRemotePublicKey {
    fn as_raw(&self) -> Result<Vec<u8>> {
        Ok(self.raw_pub_key.clone())
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[derive(Clone)]
pub struct RustCryptoLocalKeyPair {
    key: SecretKey,
}
impl fmt::Debug for RustCryptoLocalKeyPair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?}",
            base64::engine::general_purpose::URL_SAFE.encode(self.key.to_bytes())
        )
    }
}
impl RustCryptoLocalKeyPair {
    fn generate_random() -> Result<Self> {
        Ok(Self {
            key: SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng),
        })
    }
    fn from_components(components: &EcKeyComponents) -> Result<Self> {
        let key =
            SecretKey::from_slice(components.private_key()).map_err(|_| Error::CryptoError)?;
        let expected = key.public_key().to_sec1_bytes().to_vec();
        if expected != components.public_key() {
            return Err(Error::CryptoError);
        }
        Ok(Self { key })
    }
    fn public_raw(&self) -> Vec<u8> {
        self.key.public_key().to_sec1_bytes().to_vec()
    }
}
impl LocalKeyPair for RustCryptoLocalKeyPair {
    fn pub_as_raw(&self) -> Result<Vec<u8>> {
        Ok(self.public_raw())
    }
    fn raw_components(&self) -> Result<EcKeyComponents> {
        Ok(EcKeyComponents::new(
            self.key.to_bytes().to_vec(),
            self.public_raw(),
        ))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[derive(Debug, Default)]
pub struct RustCryptoCryptographer;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_noncanonical_public_key_encodings() {
        let cryptographer = RustCryptoCryptographer;
        assert!(cryptographer.import_public_key(&[0x02; 33]).is_err());
        assert!(cryptographer.import_public_key(&[0x04; 64]).is_err());
    }

    #[test]
    fn rejects_mismatched_private_and_public_components() {
        let cryptographer = RustCryptoCryptographer;
        let pair = cryptographer.generate_ephemeral_keypair().unwrap();
        let components = pair.raw_components().unwrap();
        let components = EcKeyComponents::new(components.private_key().to_vec(), vec![0x04; 65]);
        assert!(cryptographer.import_key_pair(&components).is_err());
    }
}

impl Cryptographer for RustCryptoCryptographer {
    fn generate_ephemeral_keypair(&self) -> Result<Box<dyn LocalKeyPair>> {
        Ok(Box::new(RustCryptoLocalKeyPair::generate_random()?))
    }
    fn import_key_pair(&self, components: &EcKeyComponents) -> Result<Box<dyn LocalKeyPair>> {
        Ok(Box::new(RustCryptoLocalKeyPair::from_components(
            components,
        )?))
    }
    fn import_public_key(&self, raw: &[u8]) -> Result<Box<dyn RemotePublicKey>> {
        Ok(Box::new(RustCryptoRemotePublicKey::from_raw(raw)?))
    }
    fn compute_ecdh_secret(
        &self,
        remote: &dyn RemotePublicKey,
        local: &dyn LocalKeyPair,
    ) -> Result<Vec<u8>> {
        let remote = remote
            .as_any()
            .downcast_ref::<RustCryptoRemotePublicKey>()
            .ok_or(Error::CryptoError)?;
        let local = local
            .as_any()
            .downcast_ref::<RustCryptoLocalKeyPair>()
            .ok_or(Error::CryptoError)?;
        Ok(
            ecdh::diffie_hellman(local.key.to_nonzero_scalar(), remote.key.as_affine())
                .raw_secret_bytes()
                .to_vec(),
        )
    }
    fn hkdf_sha256(&self, salt: &[u8], secret: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>> {
        let (_, hk) = Hkdf::<Sha256>::extract(Some(salt), secret);
        let mut output = vec![0; len];
        hk.expand(info, &mut output)
            .map_err(|_| Error::CryptoError)?;
        Ok(output)
    }
    fn aes_gcm_128_encrypt(&self, key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>> {
        if key.len() != 16 || iv.len() != 12 {
            return Err(Error::InvalidKeyLength);
        }
        Aes128Gcm::new_from_slice(key)
            .map_err(|_| Error::InvalidKeyLength)?
            .encrypt(Nonce::from_slice(iv), data)
            .map_err(|_| Error::CryptoError)
    }
    fn aes_gcm_128_decrypt(
        &self,
        key: &[u8],
        iv: &[u8],
        ciphertext_and_tag: &[u8],
    ) -> Result<Vec<u8>> {
        if key.len() != 16 || iv.len() != 12 || ciphertext_and_tag.len() < AES_GCM_TAG_LENGTH {
            return Err(Error::InvalidKeyLength);
        }
        Aes128Gcm::new_from_slice(key)
            .map_err(|_| Error::InvalidKeyLength)?
            .decrypt(Nonce::from_slice(iv), ciphertext_and_tag)
            .map_err(|_| Error::CryptoError)
    }
    fn random_bytes(&self, dest: &mut [u8]) -> Result<()> {
        getrandom::getrandom(dest).map_err(|_| Error::CryptoError)
    }
}
