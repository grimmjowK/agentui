"""POPO SDK 异常定义"""


class PopoSdkError(Exception):
    """POPO SDK 基础异常"""
    pass


class AuthError(PopoSdkError):
    """认证相关异常（Token 获取失败等）"""
    pass


class CryptoError(PopoSdkError):
    """加解密相关异常（AES 解密失败等）"""
    pass


class PopoConnectionError(PopoSdkError):
    """连接相关异常（WebSocket 连接失败等）"""
    pass
