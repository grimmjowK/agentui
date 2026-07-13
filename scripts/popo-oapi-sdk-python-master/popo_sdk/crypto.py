"""加解密与签名验证"""

import base64
import hashlib
import hmac
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

from .exceptions import CryptoError


def decrypt(encrypted_base64: str, aes_key: str) -> str:
    """
    AES-128-CBC 解密
    
    Args:
        encrypted_base64: Base64 编码的密文
        aes_key: 32 字符密钥，前 16 字符为 key，后 16 字符为 iv
    
    Returns:
        解密后的 UTF-8 明文字符串
    
    Raises:
        ValueError: aes_key 长度不为 32
        CryptoError: 解密失败
    """
    if not aes_key or len(aes_key) != 32:
        raise ValueError(
            f"aes_key must be exactly 32 characters, got: {len(aes_key) if aes_key else 'None'}"
        )

    try:
        key = aes_key[:16].encode("utf-8")
        iv = aes_key[16:32].encode("utf-8")
        encrypted_bytes = base64.b64decode(encrypted_base64)

        cipher = AES.new(key, AES.MODE_CBC, iv)
        decrypted = unpad(cipher.decrypt(encrypted_bytes), AES.block_size)

        return decrypted.decode("utf-8")
    except ValueError as e:
        raise CryptoError(f"AES decryption failed (padding error): {e}") from e
    except Exception as e:
        raise CryptoError(f"AES decryption failed: {e}") from e


def verify_signature(token: str, timestamp: str, nonce: str, signature: str) -> bool:
    """
    验证 POPO Webhook SHA256 签名
    
    算法：SHA256(sort([token, timestamp, nonce]).join(''))
    
    Args:
        token: 签名验证 token
        timestamp: 请求参数 timestamp
        nonce: 请求参数 nonce
        signature: 请求参数 signature（64 位十六进制）
    
    Returns:
        True 表示签名有效
    """
    if not all([token, timestamp, nonce, signature]):
        return False

    # 签名必须是 64 位十六进制
    if len(signature) != 64:
        return False
    try:
        int(signature, 16)
    except ValueError:
        return False

    # 三个值排序后拼接
    sorted_str = "".join(sorted([token, timestamp, nonce]))

    # 计算 SHA256
    computed = hashlib.sha256(sorted_str.encode("utf-8")).hexdigest().lower()

    # 时序安全比较（防时序攻击）
    return hmac.compare_digest(computed, signature.lower())
