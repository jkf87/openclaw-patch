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
openclaw-patch setup --source-distro Ubuntu-24.04 # Gateway distro가 없을 때 명시적 생성
openclaw-patch fix-port     # 포트 점유 프로세스 종료
openclaw-patch fix-wsl-host # WSL 업데이트 + shutdown
openclaw-patch fix-wsl --source-distro Ubuntu-24.04 # OpenClawGateway WSL distro 생성 보조
openclaw-patch reset-wsl-gateway --yes # 꼬인 OpenClawGateway 제거(데이터 삭제)
openclaw-patch fix-certs    # Windows CA 인증서 → WSL 동기화
openclaw-patch status       # 현재 상태 확인
openclaw-patch all          # 모든 패치 한번에 적용
```

## Setup 가이드 (권장)

```bash
# 1회차: 포트/WSL host/distro 상태 확인 → 필요한 패치 적용
openclaw-patch setup

# OpenClawGateway가 아직 없고 이 도구로 생성까지 하려면 source distro를 명시
openclaw-patch setup --source-distro Ubuntu-24.04

# 2회차: WSL 존재 확인 → CA 인증서 동기화 → 셋업 다시 실행하면 성공
openclaw-patch setup
```

## WSL Gateway 생성/등록 오류

OpenClaw Windows Hub/Companion 로컬 설치는 기존 Ubuntu를 직접 고치는 방식이 아니라,
`OpenClawGateway`라는 앱 전용 WSL 배포판을 새로 만들고 그 안에 Gateway를 설치합니다.
아래 메시지는 별도 원인이라기보다 WSL이 이 app-owned distro를 만들거나 등록하지 못한 같은 계열의 오류입니다.

| 묶음 | 화면 메시지 | 의미 |
|------|-------------|------|
| A. preflight-wsl 실패 | `WSL 2.3.24.0 cannot create a clean app-owned OpenClaw gateway distro` | 설치 전 검사에서 현재 WSL host가 app-owned distro 생성에 부적합하다고 판단 |
| B. wsl-create 실패 | `Fresh WSL install did not register expected distro 'OpenClawGateway'` | 생성 시도 후 `OpenClawGateway` 등록 확인 실패 |
| C. No gateway yet | `No gateway yet` | 위 단계 실패로 Companion이 연결할 Gateway가 없음 |

우선 WSL host 상태를 확인합니다.

```powershell
openclaw-patch status
```

`WSL 2.3.24.0`처럼 app-owned distro 생성에 문제가 있는 버전이 감지되거나 `wsl --status`가 실패하면:

```powershell
openclaw-patch fix-wsl-host

# Microsoft Store 업데이트가 막힌 환경
openclaw-patch fix-wsl-host --web-download
```

이 명령은 내부적으로 `wsl --update`와 `wsl --shutdown`을 실행합니다. 이후 Windows를 재부팅하고 OpenClaw Companion 설치를 다시 시도하세요.

이전 실패로 `OpenClawGateway`가 어중간하게 남아 있으면, Gateway 데이터를 지워도 되는 상황에서만 명시적으로 제거합니다.

```powershell
openclaw-patch reset-wsl-gateway --yes
openclaw-patch setup
```

`reset-wsl-gateway --yes`는 `wsl --unregister OpenClawGateway`를 실행하므로 해당 WSL 배포판 안의 데이터와 설정을 삭제합니다.
기본값이 아닌 distro를 지울 때는 실수 방지를 위해 대상 이름을 두 번 써야 합니다.

```powershell
openclaw-patch reset-wsl-gateway --target-distro MyGateway --confirm-distro MyGateway --yes
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

### fix-wsl-host
```
WSL 2.3.24.0 cannot create a clean app-owned OpenClaw gateway distro
Fresh WSL install did not register expected distro 'OpenClawGateway'
No gateway yet
```
WSL host 버전/상태를 점검하고, 필요한 경우 `wsl --update` + `wsl --shutdown` 후 재부팅하도록 안내.

### fix-wsl
로컬 Ubuntu 배포판이 이미 있는 경우 이를 export/import해서 `OpenClawGateway`를 만드는 우회 패치.
OpenClaw 공식 설치가 자체 WSL 생성 단계에서 TLS나 등록 문제로 실패할 때만 사용.
선택한 Ubuntu 파일시스템이 복제되므로 개인 파일/패키지가 있는 배포판 대신 깨끗한 Ubuntu를 쓰는 것을 권장.
복제 대상을 암묵적으로 고르지 않도록 `fix-wsl`과 `setup` 모두 `--source-distro`가 필수입니다.

```powershell
openclaw-patch fix-wsl --source-distro Ubuntu-24.04
openclaw-patch setup --source-distro Ubuntu-24.04
```

### reset-wsl-gateway
이전 실패로 남은 app-owned WSL state를 정리.
데이터 삭제 작업이므로 `--yes`가 없으면 실행하지 않고 안내만 출력.
