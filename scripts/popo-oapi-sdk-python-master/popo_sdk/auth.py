"""Token 认证管理"""

import logging
import threading
import time

import requests

from .exceptions import AuthError

logger = logging.getLogger("popo_sdk.auth")

# Token 过期错误码
_ERR_TOKEN_EXPIRED = 40003
_ERR_TOKEN_INVALID = 40004

# 提前 5 分钟刷新
_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000


class TokenManager:
    """AccessToken 和 OnceToken 管理器"""

    def __init__(self, app_key: str, app_secret: str, base_url: str = "https://open.popo.netease.com"):
        self._app_key = app_key
        self._app_secret = app_secret
        self._base_url = base_url.rstrip("/")
        self._access_token = None
        self._access_expired_at = 0
        self._lock = threading.Lock()

    def get_access_token(self) -> str:
        """获取 AccessToken（带缓存）"""
        now_ms = int(time.time() * 1000)
        if self._access_token and now_ms < self._access_expired_at - _TOKEN_REFRESH_BUFFER_MS:
            return self._access_token

        with self._lock:
            # 双重检查
            now_ms = int(time.time() * 1000)
            if self._access_token and now_ms < self._access_expired_at - _TOKEN_REFRESH_BUFFER_MS:
                return self._access_token
            return self._refresh_access_token()

    def invalidate_token(self):
        """使缓存失效"""
        with self._lock:
            self._access_token = None
            self._access_expired_at = 0

    def get_once_token(self):
        """
        获取 OnceToken（一次性令牌，用于 WebSocket 连接）
        
        Returns:
            tuple: (once_token, robot_uid)
        """
        return self._get_once_token(retry=True)

    def _get_once_token(self, retry: bool):
        access_token = self.get_access_token()
        url = f"{self._base_url}/open-apis/robots/v1/im/onceToken/get"

        try:
            resp = requests.post(
                url,
                json={},
                headers={
                    "Content-Type": "application/json",
                    "Open-Access-Token": access_token,
                },
                timeout=10,
                verify=False,
            )
            data = resp.json()

            if data.get("errcode") == 0 and data.get("data"):
                once_token = data["data"].get("onceToken")
                robot_uid = data["data"].get("robotUid", "")
                logger.info(f"[POPO-WS] OnceToken obtained, robotUid: {robot_uid}")
                return once_token, robot_uid

            # Token 过期，清缓存重试
            errcode = data.get("errcode")
            if errcode in (_ERR_TOKEN_EXPIRED, _ERR_TOKEN_INVALID) and retry:
                logger.warning("[POPO-WS] AccessToken expired, refreshing and retrying...")
                self.invalidate_token()
                return self._get_once_token(retry=False)

            raise AuthError(
                f"Failed to get OnceToken: errcode={errcode}, errmsg={data.get('errmsg')}"
            )
        except AuthError:
            raise
        except Exception as e:
            raise AuthError(f"Failed to get OnceToken: {e}") from e

    def _refresh_access_token(self) -> str:
        url = f"{self._base_url}/open-apis/robots/v1/token"

        try:
            resp = requests.post(
                url,
                json={"appKey": self._app_key, "appSecret": self._app_secret},
                headers={"Content-Type": "application/json"},
                timeout=10,
                verify=False,
            )
            data = resp.json()

            if data.get("errcode") != 0 or not data.get("data"):
                raise AuthError(
                    f"Failed to get AccessToken: errcode={data.get('errcode')}, errmsg={data.get('errmsg')}"
                )

            self._access_token = data["data"]["accessToken"]
            self._access_expired_at = data["data"].get("accessExpiredAt", 0)
            logger.info(f"[POPO-WS] AccessToken refreshed, expires at: {self._access_expired_at}")
            return self._access_token
        except AuthError:
            raise
        except Exception as e:
            raise AuthError(f"Failed to refresh AccessToken: {e}") from e
