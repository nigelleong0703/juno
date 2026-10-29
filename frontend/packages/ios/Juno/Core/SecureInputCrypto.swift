import CryptoKit
import Foundation

/// End-to-end encryption of secure-input values (BACKEND 8.7 item 7): each value is sealed to the computer's own
/// X25519 key, so the server, the model and the network only ever carry ciphertext.
enum SecureSeal {
    static let algorithm = "X25519-HKDF-SHA256-AES256GCM"
    private static let info = Data("juno-secure-input-v1".utf8)

    enum Failure: LocalizedError {
        /// The request carries no (usable) `encryption`: it comes from an older computer.
        case olderComputer
        var errorDescription: String? { "This request is from an older computer — cancel and ask again." }
    }

    /// `ephemeral` and `nonce` are only injected by the shared test vector.
    static func seal(_ value: String, encryption: Contract.SecureInputEncryption?, requestId: String, fieldId: String, ref: String?,
                     ephemeral: Curve25519.KeyAgreement.PrivateKey = .init(), nonce: AES.GCM.Nonce = .init()) throws -> Contract.SealedSecureValue {
        guard let encryption, encryption.alg == algorithm, let raw = encryption.publicKey.flatMap({ Data(base64Encoded: $0) }) else { throw Failure.olderComputer }
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(requestId.utf8), sharedInfo: info, outputByteCount: 32)
        let aad = Data("\(requestId)|\(fieldId)|\(ref ?? "")".utf8)
        let box = try AES.GCM.seal(Data(value.utf8), using: key, nonce: nonce, authenticating: aad)
        return Contract.SealedSecureValue(epk: ephemeral.publicKey.rawRepresentation.base64EncodedString(),
                                          nonce: Data(nonce).base64EncodedString(),
                                          ciphertext: (box.ciphertext + box.tag).base64EncodedString())
    }
}
