# Deployment

## What you'll need

* A valid domain (e.g. `taskminder.de`)
* A server (minimum 2GB RAM and 20GB storage) running Ubuntu (≥ 24.04 LTS) with sudo or root access
* The codebase of TaskMinder from [https://github.com/TaskMinder/TaskMinder](https://github.com/TaskMinder/TaskMinder)

---

## 1. DNS Configuration

Before proceeding with the server setup, configure your domain to point to your Ubuntu server.

### Get Your Server's Public IP Address

On your server, run:

```bash
curl ifconfig.me
```

Copy the returned IP (e.g., `203.0.113.42`). Make sure the server is not behind a router. The following guide will use this example IP — **replace it with your actual IP**.

---

### Configure DNS Records

Go to your domain registrar’s DNS management page (e.g., Namecheap, GoDaddy, Cloudflare etc.) and add the following records:

| **Type** | **Name** | **Value (replace)**      | **TTL**          |
| -------- | -------- | -------------- | ---------------- |
| A        | @        | `203.0.113.42` | Automatic / 3600 |
| A        | www      | `203.0.113.42` | Automatic / 3600 |
| A        | app      | `203.0.113.42` | Automatic / 3600 |

> This assumes you're using `example.com` and want `www.example.com` to also work.

We also use a subdomain for monitoring (`monitoring.example.com`) and a subdomain for a status page.

We use [https://betterstack.com/](https://betterstack.com/) as it offers custom subdomains for the status page, but you may choose another provider. After setting up the status page, follow BetterStack’s instructions to configure the CNAME record.

For the monitoring page (`monitoring.example.com`), add the following record:

| **Type** | **Name**   | **Value (replace)**      |
| -------- | ---------- | -------------- |
| A        | monitoring | `203.0.113.42` |

---

### Wait for Propagation

DNS propagation can take a few minutes to several hours. Use tools like:

- [https://dnschecker.org](https://dnschecker.org)

Once your domain resolves to your server’s IP, proceed to the next step.

---

## 2. Install Required Packages

### Update and install dependencies:

This installs (if not already installed) Git, curl, NGINX, libnginx-mod-http-lua (for Lua in NGINX), lua-cjson (for NGINX), gettext-base (provides `envsubst`, used to render the NGINX template), UFW, and Fail2Ban:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl nginx ufw fail2ban libnginx-mod-http-lua lua-cjson gettext-base
```

### Verify lua was installed and is enabled:

See if the module was auto-enabled, if not, enable it first before proceeding:

```bash
ls /etc/nginx/modules-enabled/ | grep lua
```

### Install Docker and Docker Compose:

Follow the official Docker documentation to install Docker and Docker Compose:

🔗 [https://docs.docker.com/engine/install/ubuntu/](https://docs.docker.com/engine/install/ubuntu/)

### Enable and start Docker

```bash
sudo systemctl enable docker
sudo systemctl start docker
```

---

### Enable and configure firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### Configure Fail2Ban

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

Check status:

```bash
sudo fail2ban-client status
```

---

## 3. Clone the Project from GitHub

```bash
cd /opt
sudo git clone https://github.com/TaskMinder/TaskMinder.git
cd TaskMinder
```

---

## 4. Configure NGINX

NGINX terminates TLS and routes the four hostnames to their containers. It does not serve static files or set cache rules and security headers, as the containers already do that themselves.

The repository contains `nginx.config.template` instead of a finished config. You render it with your own hostnames, as shown below.

### Install Certbot and Obtain SSL Certificates

Install Certbot and its NGINX plugin:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Run Certbot to obtain SSL certificates (replace `example.com` and subdomains with your actual domains):

```bash
sudo certbot -d example.com -d app.example.com -d www.example.com -d monitoring.example.com
```

Certbot will automatically update the configuration file at `/etc/nginx/sites-available/default`. Delete this file, as you’ll be using your custom config instead. Also, delete the symlink: `sudo rm /etc/nginx/sites-enabled/default`

### Store the certificate paths in one file

Every server block uses the same TLS settings. Put them in one file instead of repeating them (replace `example.com` with the certificate name Certbot reported):

```bash
sudo tee /etc/nginx/taskminder-tls.conf > /dev/null <<'EOF'
ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
include /etc/letsencrypt/options-ssl-nginx.conf;
ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
EOF
```

### Add Gzip and Lua settings in the main `/etc/nginx/nginx.conf`

Open the main nginx configuration file:

```bash
sudo nano /etc/nginx/nginx.conf
```

Inside the `http { } block`, comment out all related gzip lines, as we will be using it for compression work. Furthermore, add this line in the http block:

```bash
##
# Lua Maintenance Flag Setting
##
lua_shared_dict maintenance_flag 1m;
```


### Deploy Your Final NGINX Configuration

Install the shared proxy headers, then render the template with your hostnames:

```bash
# Proxy headers, the same in every environment
sudo cp /opt/TaskMinder/nginx.proxy-headers.conf /etc/nginx/taskminder-proxy.conf

# Render the site config (replace example.com with your base domain)
LANDING_HOST=example.com \
WWW_HOST=www.example.com \
APP_HOST=app.example.com \
MONITORING_HOST=monitoring.example.com \
TLS_INCLUDE=/etc/nginx/taskminder-tls.conf \
envsubst '${LANDING_HOST} ${WWW_HOST} ${APP_HOST} ${MONITORING_HOST} ${TLS_INCLUDE}' \
  < /opt/TaskMinder/nginx.config.template \
  | sudo tee /etc/nginx/sites-available/taskminder > /dev/null

# Enable and test the configuration
sudo ln -s /etc/nginx/sites-available/taskminder /etc/nginx/sites-enabled/
sudo nginx -t

# Restart NGINX to apply changes
sudo systemctl restart nginx
```

The variable list after `envsubst` is required. Without it, `envsubst` also replaces NGINX’s own `$host` and `$request_uri` with empty strings.

Re-run the same command after pulling a new version of the template.

### Point the project page at your application hostname

The project page redirects unknown paths and its own `/join` and `/about` links to the application. `compose.yaml` ships `APP_HOST: app.taskminder.de`, which is only correct for the official deployment.

Do not edit `compose.yaml` itself — it is tracked, so the next `git pull` will either conflict with your edit or revert it. Create a `compose.override.yaml` next to it instead. Docker Compose merges that file automatically, and because it is untracked it survives every pull:

```bash
cat > /opt/TaskMinder/compose.override.yaml <<'EOF'
services:
  landing:
    environment:
      APP_HOST: app.example.com
EOF
```

Verify the value actually reached the container once the stack is up:

```bash
curl -sI http://127.0.0.1:3002/main | grep -i "^location"
# must print your own application host, not app.taskminder.de
```

---

## 5. Set Up Non-Root User

Running as root means a compromised container could gain full system access. It is highly recommended to run the server as a non-root user (least privilege). We’ll use the name `ubuntu` for this guide, but you may choose another name.

```bash
sudo adduser ubuntu
sudo usermod -aG sudo ubuntu
sudo usermod -aG docker ubuntu
```

If `adduser` fails, the user likely already exists (common on cloud providers like AWS or DigitalOcean). In that case, just add them to the `docker` group:

```bash
sudo usermod -aG docker ubuntu
```

Give the user access to the project folder:

```bash
sudo chown -R ubuntu:ubuntu /opt/TaskMinder
```

Log out and reconnect as the `ubuntu` user:

```bash
exit
ssh ubuntu@<your-ip-address>
```

For enhanced security, use SSH key-based authentication instead of password-based logins to reduce the risk of unauthorized access. After adding your SSH key and verifying the connection, disable both root logins and password authentication:

Edit and/or uncomment the following lines in `/etc/ssh/sshd_config`:

```bash
PermitRootLogin no
PasswordAuthentication no
```

Then restart SSH:

```bash
sudo systemctl restart ssh
```

---

## 6. Automated Backup Setup (via Cron)

### Make the Backup Script Executable

The `cron` service needs permission to run the script. You only need to do this once.

```bash
chmod +x /opt/TaskMinder/backup-cmds/db_backup.sh
```

### Add the Job to Crontab

This will schedule the script to run automatically.

Open the crontab editor for the current user:

```bash
   crontab -e
```

Add the following line to the bottom of the file, then save and exit:

```bash
   0 * * * * /opt/TaskMinder/backup-cmds/db_backup.sh >> /var/log/backup.log 2>&1
```

### Verify the Setup

Confirm the job was added successfully by listing the active cron jobs:

```bash
   crontab -l
```

You should see the line you just added.

---

## 7. Add Docker Secrets and .env.production

Navigate back to the TaskMinder folder and create directories for secrets and backups:

```bash
cd /opt/TaskMinder
mkdir docker_secrets
mkdir db-backups
```

Before starting the application, create the following text files inside the `docker_secrets/` folder. These files are used as Docker secrets for configuration:

| **Filename**                   | **Description**                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `db_name.txt`                  | Name of the PostgreSQL database.                                                                               |
| `db_password.txt`              | Password for the PostgreSQL database user.                                                                     |
| `db_user.txt`                  | PostgreSQL database username.                                                                                  |
| `session_secret.txt`           | Secure session secret (e.g., generate one with `openssl rand -base64 32`).                                     |
| `database_url.txt`             | Provides the database URL for Prisma ORM: `postgresql://db_user:db_password@taskminder-postgres:5432/db_name`  |
| `encryption_key.txt`           | Encryption key for server-side encryption in the database, generated with `openssl rand -base64 32`            |
| `encryption_key_secondary.txt` | Rotation key for server-side encryption, generated with `openssl rand -base64 32`                              |
| `encryption_key_lookup.txt`    | Lookup key for hashes for server-side encryption, generated with `openssl rand -base64 32`                     |
| `proxy_hop.txt`                | Proxy hop count for additional reverse proxies that are configured by the server provider. Add 1 to account for the NGINX config.|
| `brevo_api_key.txt`            | API key of [Brevo](https://www.brevo.com) for the moderation mails (sender domain must be authenticated in Brevo). |
| `moderation_password.txt`      | Password of the moderation panel at `/moderation`, generated with `openssl rand -base64 32` (at least 24 characters, else the server does not start) |

---

## 8. Run Docker Compose and reset git changes

Navigate to the project root and build/start the containers:

```bash
cd /opt/TaskMinder
docker compose up -d --build
```

Reset git changes:

```bash
git reset --hard
```

And build/start the containers again:
```bash
docker compose up -d --build
```

---

## 9. TaskMinder Deployment Complete

Your TaskMinder server should now be running at:

- **[https://example.com](https://example.com)**
- **[https://app.example.com](https://app.example.com)**
- **[https://www.example.com](https://www.example.com)**
- **[https://monitoring.example.com](https://monitoring.example.com)**

---

## 10. What's Next?

- Create an account to set up a class and add your subjects, teams, and timetable.
- Visit [https://monitoring.example.com](https://monitoring.example.com) to change the default password **"admin"** to a secure one. You’ll be prompted to do this upon your first login.

---

## 11. Subsequent Updates

This guide covers minor version upgrades.
For **major version upgrades**, please refer to the relevant migration guides to check for any breaking changes.
Before upgrading, enable maintenance mode by adding a file flag with:

```bash
touch /etc/nginx/maintenance.flag
```

1. Navigate to the root folder of the project and stop the `app` service. The project page runs in its own container, so it keeps serving while the application is down:

   ```bash
   docker compose stop app
   ```

   Do not use `docker compose down` here, as it would stop the project page as well.

2. Pull the latest changes from the `main` branch on GitHub:

   ```bash
   git pull origin main
   ```

3. Rebuild and restart the Docker containers. The project page image is rebuilt too, as it comes from the same frontend build:

   ```bash
   docker compose up -d --build
   ```

   If the frontend changed, the project page image changes with it and Compose recreates that container as well. The project page is therefore unreachable for the second or two the new container needs to start, and NGINX serves `maintenance.html` for that window rather than a `502`. Only the application is covered by the maintenance flag; the project page relies on this fallback.

4. Disable maintenance mode:

   ```bash
   rm /etc/nginx/maintenance.flag
   ```

> If the application stops or crashes without the flag set, NGINX still serves `maintenance.html` instead of a `502`.

---
