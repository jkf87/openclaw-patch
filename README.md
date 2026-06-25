# openclaw-patch

OpenClaw Windows 설치 실패를 해결하는 CLI 패치 도구.

## Install

```bash
# 로컬 설치 (TLS 이슈로 npm registry 접근 안 될 때)
git clone https://github.com/jkf87/openclaw-patch.git
cd openclaw-patch
npm install -g .

# 또는 GitHub에서 직접
npm install -g jkf87/openclaw-patch
```

## Usage

```bash
openclaw-patch              # 가이드 모드 (setup)
openclaw-patch setup        # 상황에 맞는 자동 패치 + 가이드
openclaw-patch fix-port     # 포트 점유 프로세스 종료
openclaw-patch fix-certs    # Windows CA 인증서 → WSL 동기화
openclaw-patch status       # 현재 상태 확인
openclaw-patch all          # 모든 패치 한번에 적용
```

## Setup 가이드 (권장)

```bash
# 1회차: 포트 해제 → OpenClaw 셋업 실행 (WSL 생성됨, install-cli에서 TLS 에러)
openclaw-patch setup

# 2회차: WSL 존재 확인 → CA 인증서 동기화 → 셋업 다시 실행하면 성공
openclaw-patch setup
```

## 설정 자동 감지

포트와 distro 이름을 하드코딩하지 않고 자동으로 읽어옵니다:

| 우선순위 | 소스 | 경로 |
|---------|------|------|
| 1 (낮음) | 기본값 | port: 18789, distro: OpenClawGateway |
| 2 | Setup config | `%APPDATA%\OpenClawTray\setup-config.json` |
| 3 | Tray settings | `%APPDATA%\OpenClawTray\settings.json` |
| 4 (높음) | CLI 인자 | `--port`, `--distro` |

```bash
# 커스텀 포트/distro 사용 예시
openclaw-patch setup --port 19000 --distro MyGateway
```

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
