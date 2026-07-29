# Oracle Cloud 무료 배포 (Ampere A1 / Always Free)

Gaia Project 웹서버를 Oracle Cloud "Always Free"(A1 최대 4 OCPU·24GB RAM, egress 10TB/월)에 올리는 절차.

## A. Oracle 콘솔 (브라우저, ~10분)

1. **가입**: https://www.oracle.com/cloud/free/ — 카드 등록 필요(과금 안 됨, 인증용). 홈 리전은 **가까운 곳(예: 서울 ap-seoul-1, 춘천 ap-chuncheon-1)**.
2. **인스턴스 생성**: Menu → Compute → Instances → **Create instance**
   - Image: **Canonical Ubuntu 22.04**
   - Shape: **Ampere / VM.Standard.A1.Flex** → OCPU **2~4**, RAM **12~24GB** (모두 Always Free 한도).
     - "Out of capacity" 뜨면 리전/AD 바꾸거나 잠시 후 재시도(무료 A1은 경쟁 심함).
   - SSH keys: **Save private key** 로 키페어 내려받기(로그인에 씀).
   - Networking: 기본 VCN 자동 생성 허용.
   - **Create**.
3. **공인 IP 확인**: 인스턴스 상세의 Public IP 메모.
4. **포트 개방 (VCN Security List)**: 인스턴스 → Virtual Cloud Network → 해당 VCN → **Security Lists** → Default → **Add Ingress Rules**
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **5000** (또는 원하는 포트), Save.
   - (HTTP/HTTPS로 도메인 붙일 거면 80, 443 도 추가.)

## B. 서버 셋업 (SSH)

```bash
# 로컬에서 접속 (내려받은 키 권한 조정)
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<공인IP>
```

서버 안에서 코드 배치 → 셋업 스크립트 실행:

```bash
sudo mkdir -p /opt/GaiaProjectWeb && sudo chown ubuntu:ubuntu /opt/GaiaProjectWeb

# 코드 가져오기 (private repo → PAT 또는 배포키). 예: PAT
git clone https://<GITHUB_PAT>@github.com/Hi-Berry/GaiaProjectWeb.git /opt/GaiaProjectWeb
cd /opt/GaiaProjectWeb

# (선택) 비밀키/환경변수 — 인메모리로 쓸 거면 생략 가능
sudo tee /etc/gaia.env >/dev/null <<'EOF'
# DATABASE_URL=postgres://...        # 없으면 인메모리(재시작 시 진행중 게임 유실)
# SUPABASE_URL=...
# SUPABASE_SERVICE_ROLE_KEY=...      # 사람게임 로그 저장용
# HUMAN_LOG_STORAGE=supabase
EOF
sudo chmod 600 /etc/gaia.env

# 원클릭 셋업 (Node설치 → 빌드 → 방화벽 → systemd)
bash deploy/setup-oracle.sh
```

접속: `http://<공인IP>:5000`

## C. 업데이트 (코드 새로 배포)

```bash
cd /opt/GaiaProjectWeb
git pull
npm ci && npm run build
sudo systemctl restart gaia
journalctl -u gaia -f     # 로그 확인
```

## D. (선택) 도메인 + HTTPS

WebSocket(socket.io)은 HTTPS면 `wss://`라 리버스 프록시가 필요:

```bash
sudo apt-get install -y nginx
# /etc/nginx/sites-available/gaia 에 proxy_pass http://127.0.0.1:5000 + Upgrade 헤더 설정
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com   # Let's Encrypt 자동
```
이 경우 VCN/iptables에 80·443 개방, 5000은 닫아도 됨.

## 함정 메모
- **방화벽 2겹**: Oracle VCN Security List(콘솔) + 인스턴스 iptables(스크립트가 처리). 둘 다 열어야 함.
- **A1 용량 부족**: 무료 A1은 생성이 자주 막힘 — 리전/AD 변경·재시도.
- **인메모리 스토리지**: `DATABASE_URL` 없으면 재시작 시 진행 중 게임 사라짐(로그는 Supabase 저장 별개).
- **포트 80 직접 쓰기**: Node를 80에 바인딩하려면 `sudo setcap 'cap_net_bind_service=+ep' $(which node)` 또는 nginx/redirect 사용.
