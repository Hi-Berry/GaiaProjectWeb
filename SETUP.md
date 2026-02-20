# 프로젝트 실행 방법 (Setup Instructions)

현재 시스템에서 Node.js가 감지되지 않았습니다. 게임을 실행하기 위해서는 Node.js 설치가 필요합니다.

## 1. Node.js 설치
1. [Node.js 공식 홈페이지](https://nodejs.org/)에 접속합니다.
2. **LTS (Long Term Support)** 버전을 다운로드하고 설치합니다.
3. 설치가 완료되면 컴퓨터를 재부팅하거나 새로운 터미널을 열어주세요.

## 2. 프로젝트 설정
터미널(PowerShell 또는 CMD)을 열고 프로젝트 폴더(`d:\GaiaProjectWeb`)로 이동한 뒤 아래 명령어를 차례로 입력하세요.

### 의존성 패키지 설치
이 명령어를 실행하여 필요한 라이브러리(`node_modules`)를 다운로드합니다. 이 과정은 처음에 한 번만 필요합니다.
```bash
npm install
```

## 3. 게임 실행
설치가 완료되면 아래 명령어로 개발 서버를 실행합니다.
```bash
npm run dev
```

서버가 실행되면 브라우저에서 아래 주소로 접속하세요:
http://localhost:5000

## 문제 해결 (Troubleshooting)
- **`npm` 명령어를 찾을 수 없다는 오류가 뜰 경우**: Node.js가 제대로 설치되지 않았거나 환경 변수(PATH)에 추가되지 않은 것입니다. 설치 프로그램을 다시 실행하여 "Add to PATH" 옵션이 체크되어 있는지 확인하세요.
- **포트 충돌**: 5000번 포트가 이미 사용 중이라면 `server/index.ts` 파일에서 포트 번호를 변경할 수 있습니다.
