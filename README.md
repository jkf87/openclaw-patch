# openclaw-patch

OpenClaw Windows 설치 실패를 해결하는 CLI 패치 도구.

## Install

```bash
npm install -g openclaw-patch
```

## Usage

```bash
openclaw-patch              # 모든 패치 적용
openclaw-patch fix-port     # 포트 18789 점유 프로세스 종료
openclaw-patch fix-certs    # Windows CA 인증서 → WSL 동기화
openclaw-patch status       # 현재 상태 확인
```

## 순서

1. OpenClaw 트레이 앱 설치 (기존 방법)
2. `openclaw-patch` 실행
3. OpenClaw Setup 실행

## Fixes

### fix-port
```
Step 'preflight-port' failed: Port 18789 is already in use (AddressAlreadyInUse)
```
이전 실행에서 남은 gateway 프로세스를 종료하여 포트 해제.

### fix-certs
```
curl: (60) SSL certificate problem: self-signed certificate in certificate chain
```
기업 네트워크의 TLS 프록시 인증서를 WSL Ubuntu에 주입하여 curl 인증서 검증 통과.
