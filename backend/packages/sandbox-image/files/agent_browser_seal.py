"""End-to-end encrypted secure input (BACKEND 8.7): the sandbox's X25519 key and the unsealing of values.

The helper (run as root by the platform, never as the agent's user) owns one X25519 key pair per sandbox.
The private key lives in a 0600 file under a 0700 root directory, is generated on first use and never leaves
this process: only the public key and its id are handed out. A client seals each value to that public key:

    shared = X25519(ephemeral private key, sandbox public key)
    key    = HKDF-SHA256(shared, salt = requestId (UTF-8), info = "juno-secure-input-v1", 32 bytes)
    box    = AES-256-GCM(key, random 12-byte nonce, AAD = "<requestId>|<fieldId>|<ref>").encrypt(value UTF-8)

and sends {epk, nonce, ciphertext} (base64; epk is the raw 32-byte public key, ciphertext ends with the 16-byte tag).
agentd, computerd and the sandbox provider pass these three strings on untouched. A sandbox that is recreated
has no key file, so it gets a new key (a request raised before that fails to unseal: ask again).
"""
import base64
import binascii
import fcntl
import hashlib
import os
from typing import Any, Dict, Tuple

from agent_browser_cdp import HelperError

ALG = "X25519-HKDF-SHA256-AES256GCM"
INFO = b"juno-secure-input-v1"
KEY_DIR = os.environ.get("AGENT_BROWSER_KEYDIR", "/etc/juno/secure-input")
MAX_SECRET_LEN = 512


def _crypto():
    # type: () -> Any
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    except ImportError as exc:
        raise HelperError("secure input needs the python3-cryptography package in this image: %s" % exc)
    return (hashes, serialization, X25519PrivateKey, X25519PublicKey, AESGCM, HKDF)


def _raw_public(private):
    # type: (Any) -> bytes
    serialization = _crypto()[1]
    return private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def key_id(public_raw):
    # type: (bytes) -> str
    """First 8 bytes of sha256(public key), hex: names the key so a client and the sandbox agree on which one."""
    return hashlib.sha256(public_raw).hexdigest()[:16]


def load_private():
    # type: () -> Any
    """The sandbox's private key; created (0600, in a 0700 directory) on first use under a lock."""
    X25519PrivateKey = _crypto()[2]
    os.makedirs(KEY_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(KEY_DIR, "x25519.key")
    with open(os.path.join(KEY_DIR, ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not os.path.exists(path):
            raw = os.urandom(32)
            fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
            os.replace(path + ".tmp", path)
        with open(path, "rb") as handle:
            raw = handle.read()
    if len(raw) != 32:
        raise HelperError("the secure-input key file is damaged")
    return X25519PrivateKey.from_private_bytes(raw)


def public_info():
    # type: () -> Dict[str, str]
    """What the request offers the client: the algorithm, the key id and the raw public key (base64)."""
    public = _raw_public(load_private())
    return {"alg": ALG, "keyId": key_id(public), "publicKey": base64.b64encode(public).decode("ascii")}


def _b64(value, size, name):
    # type: (Any, Tuple[int, int], str) -> bytes
    if not isinstance(value, str):
        raise HelperError("the sealed value is malformed (%s)" % name)
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise HelperError("the sealed value is malformed (%s)" % name)
    if not size[0] <= len(raw) <= size[1]:
        raise HelperError("the sealed value is malformed (%s)" % name)
    return raw


def unseal(private, sealed, request_id, field_id, ref):
    # type: (Any, Any, str, str, str) -> str
    """The secret inside `sealed` for exactly this request, field and page ref; errors never quote anything."""
    if not isinstance(sealed, dict) or set(sealed) != {"epk", "nonce", "ciphertext"}:
        raise HelperError("the sealed value is malformed")
    hashes, _serialization, _priv, X25519PublicKey, AESGCM, HKDF = _crypto()
    epk = _b64(sealed["epk"], (32, 32), "epk")
    nonce = _b64(sealed["nonce"], (12, 12), "nonce")
    box = _b64(sealed["ciphertext"], (17, MAX_SECRET_LEN * 4 + 16), "ciphertext")
    if not all(isinstance(part, str) and part for part in (request_id, field_id, ref)):
        raise HelperError("the sealed value is not bound to a request, field and ref")
    try:
        shared = private.exchange(X25519PublicKey.from_public_bytes(epk))
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=request_id.encode("utf-8"), info=INFO).derive(shared)
        aad = ("%s|%s|%s" % (request_id, field_id, ref)).encode("utf-8")
        plain = AESGCM(key).decrypt(nonce, box, aad)
        value = plain.decode("utf-8")
    except Exception:
        raise HelperError("the value could not be unsealed (wrong key, request, field or ref; ask the user again)")
    if not 1 <= len(value) <= MAX_SECRET_LEN:
        raise HelperError("the value must be 1..%d characters" % MAX_SECRET_LEN)
    return value
