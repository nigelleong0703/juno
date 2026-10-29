import CryptoKit
import XCTest
@testable import Juno

/// The shared vector (backend `public-contracts/src/secure-input-vector.json`) and the vault's Keychain round trip.
final class SecureInputTests: XCTestCase {
    private func b64(_ s: String) -> Data { Data(base64Encoded: s)! }

    func testSealMatchesTheSharedVectorByteForByte() throws {
        let encryption = Contract.SecureInputEncryption(alg: "X25519-HKDF-SHA256-AES256GCM", keyId: "aaa8fff703b50b22",
                                                        publicKey: "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=")
        let sealed = try SecureSeal.seal("4242 4242 4242 4242 é", encryption: encryption, requestId: "req_secure_vector_1", fieldId: "f1", ref: "e12",
                                         ephemeral: try .init(rawRepresentation: b64("oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=")),
                                         nonce: try .init(data: b64("EBESExQVFhcYGRob")))
        XCTAssertEqual(sealed.epk, "YFpyXSpK3+6xop4X7dYhwbdZPujNvESsbEq24vgF0jw=")
        XCTAssertEqual(sealed.nonce, "EBESExQVFhcYGRob")
        XCTAssertEqual(sealed.ciphertext, "5ofwMWoFizczNi3M7AfXP4YSSPNzjaEv/awae7TtwSuGeLuie9g=")
    }

    func testARequestWithoutAKeyIsFromAnOlderComputer() {
        XCTAssertThrowsError(try SecureSeal.seal("x", encryption: nil, requestId: "r", fieldId: "f1", ref: nil)) {
            XCTAssertTrue($0 is SecureSeal.Failure)
        }
    }

    func testVaultKeepsFreeLabelledEntriesInTheKeychain() {
        let id = "test-entry-\(UUID().uuidString)"
        defer { SecureVault.delete(id) }
        XCTAssertEqual(SecureVault.save("4242424242424242", label: "Visa ending 4242", kind: "card", id: id), id)
        XCTAssertEqual(SecureVault.value(id), "4242424242424242")
        XCTAssertEqual(SecureVault.entries().first { $0.id == id }?.label, "Visa ending 4242")
        XCTAssertEqual(SecureVault.entries().first { $0.id == id }?.kind, "card")
        // Saving again under the same id replaces it (relabel), it does not add a copy.
        XCTAssertEqual(SecureVault.save("4242424242424242", label: "Work Visa", kind: "card", id: id), id)
        XCTAssertEqual(SecureVault.entries().filter { $0.id == id }.map(\.label), ["Work Visa"])
        SecureVault.delete(id)
        XCTAssertNil(SecureVault.value(id))
        // Security codes, one-time codes, empty names and unknown kinds are refused.
        XCTAssertNil(SecureVault.save("123", label: "Card CVC", kind: "card"))
        XCTAssertNil(SecureVault.save("123456", label: "One-time code", kind: "other"))
        XCTAssertNil(SecureVault.save("x", label: "  ", kind: "other"))
        XCTAssertNil(SecureVault.save("x", label: "Thing", kind: "code"))
    }

    func testWhichFieldsCanBeSavedAndUnderWhatLabel() {
        var number = QuestionField(id: "f1"); number.label = "Card number"
        XCTAssertEqual(SecureVault.kind(for: number, fieldKind: "card_number"), "card")
        var holder = QuestionField(id: "f2"); holder.label = "Name on card"
        XCTAssertEqual(SecureVault.kind(for: holder, fieldKind: "name"), "card")
        var first = QuestionField(id: "f3"); first.label = "First name"
        XCTAssertNil(SecureVault.kind(for: first, fieldKind: "name"))
        XCTAssertNil(SecureVault.kind(for: first, fieldKind: "card_cvc"))
        XCTAssertNil(SecureVault.kind(for: first, fieldKind: "otp"))
        var password = QuestionField(id: "f4"); password.label = "Password"; password.kind = "password"
        XCTAssertEqual(SecureVault.kind(for: password, fieldKind: "password"), "password")
        XCTAssertEqual(SecureVault.defaultLabel(for: password, site: "apple.com"), "apple.com password")
        XCTAssertEqual(SecureVault.defaultLabel(for: number, site: "apple.com"), "Card number")
    }
}
