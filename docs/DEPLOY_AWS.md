# Deploying DocuMind on AWS (EC2 + Docker Compose)

The simplest way to get a live link: one EC2 virtual machine running the same `docker compose` setup you use locally. You do these steps yourself in your own AWS account. Never commit or share your AWS keys or Gemini key.

> Cost: an EC2 instance costs money while it runs. Check current EC2 pricing and your free-tier/credit status first, set a billing alarm, and **stop the instance when you are not demoing**.

## 1. Launch the instance

AWS Console → EC2 → **Launch instance**.

- **Name:** `documind`
- **AMI:** Ubuntu Server 24.04 LTS (x86_64)
- **Instance type:** `t3.medium` (4 GB RAM) is recommended. The embedding model, re-ranker, Postgres and the Next.js build together need more than 2 GB. `t3.small` may work if you add swap (step 3).
- **Key pair:** create one and download the `.pem` file. Keep it private.
- **Storage:** 20 GB gp3.
- **Security group (inbound rules):**
  - SSH, TCP 22, source **My IP**
  - Custom TCP 3001, source 0.0.0.0/0 (the app)
  - Custom TCP 8001, source 0.0.0.0/0 (the API, because the browser calls it directly)
  - Do **not** open 5432. Compose binds Postgres to 127.0.0.1 anyway.

Optional but recommended: EC2 → Elastic IPs → allocate one and associate it with the instance, so the address does not change when you stop/start.

## 2. Connect

From PowerShell on Windows:

```powershell
ssh -i C:\path\to\documind.pem ubuntu@<PUBLIC_IP>
```

## 3. Install Docker (on the instance)

```bash
sudo apt-get update
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit   # log out and back in so the group change applies
```

Only if you chose t3.small, add 2 GB of swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Get the code and configure

```bash
git clone https://github.com/vishal1230/documind.git
cd documind
cp backend/.env.example backend/.env
nano backend/.env          # paste GEMINI_API_KEY, save with Ctrl+O, exit with Ctrl+X

# Tell the frontend where the API is, and allow that origin in CORS
cat > .env <<EOT
PUBLIC_API_URL=http://<PUBLIC_IP>:8001
CORS_ORIGINS=["http://<PUBLIC_IP>:3001"]
EOT
```

Replace `<PUBLIC_IP>` with your instance's public IP (or Elastic IP).

**Also set a secret for logins** (anyone who knows it could forge a login). In `backend/.env`:

```bash
python3 -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))" >> backend/.env
```

When you add HTTPS (section 7), also add `COOKIE_SECURE=true`.

## 5. Start

```bash
docker compose up -d --build
docker compose ps           # all three should be "running" / "healthy"
docker compose logs -f backend
```

Open `http://<PUBLIC_IP>:3001`, upload the files from `sample_docs/` and ask a question. That URL is your live demo link for the README and résumé.

## 6. Updating

```bash
cd documind
git pull
docker compose up -d --build
```

## 7. Optional: HTTPS and a domain

For a cleaner link (`https://documind.yourdomain.com`), point a domain at the Elastic IP and put Caddy in front as a reverse proxy. It gets free Let's Encrypt certificates automatically. Then set `PUBLIC_API_URL=https://api.yourdomain.com`, update `CORS_ORIGINS` to match, rebuild, and close ports 3001/8001 in the security group in favour of 80/443.

> The microphone button needs **HTTPS** (browsers only allow mic access on https:// or localhost). On a plain `http://<IP>:3001` link, voice input won't work; everything else will.

## 8. Stop paying when you're done

- **Stop** the instance (EC2 → Instance state → Stop): no compute charge, small storage charge, and your data stays.
- **Terminate** it to delete everything, and release the Elastic IP (unattached Elastic IPs are charged).

## Troubleshooting

| Problem | Fix |
|---|---|
| Page loads but says "Cannot reach the API" | `PUBLIC_API_URL` is wrong or port 8001 is closed in the security group. Change `.env`, then `docker compose up -d --build frontend` |
| CORS error in the browser console | `CORS_ORIGINS` must exactly match the URL in the address bar (scheme, IP and port) |
| Build killed / very slow | Out of memory: use t3.medium or add swap |
| 503 "GEMINI_API_KEY is not set" | Add the key to `backend/.env`, then `docker compose up -d backend` |
| Gemini model or quota error | Set `GEMINI_MODEL` in `backend/.env` to another current model from the Gemini docs |
