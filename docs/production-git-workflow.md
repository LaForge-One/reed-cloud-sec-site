# Production Git Workflow

This project should live in a private GitHub repository. The repository is the source of truth for the Reed Technology Group landing page and inquiry API.

## Repository Contents

Commit application source and public assets:

- `index.html`
- `styles.css`
- `assets/`
- `server.js`
- `functions/`
- `scripts/`
- `.github/workflows/`
- `.env.example`

Do not commit production secrets, local environment files, local outbox files, or packaged zip archives.

## GitHub Repository Setup

Create a private GitHub repository named:

```text
reed-cloud-sec-site
```

Then connect this local project:

```bash
git remote add origin git@github.com:<your-github-org-or-user>/reed-cloud-sec-site.git
git branch -M main
git push -u origin main
```

## VPS Application Location

The production application files should live outside the public web root:

```text
/home/marsel/private app/reed-cloud-sec
```

The public web root should contain only browser-safe files:

```text
/home/marsel/public_html/index.html
/home/marsel/public_html/styles.css
/home/marsel/public_html/assets/
```

The production SMTP token belongs only in:

```text
/etc/reed-cloud-sec.env
```

## Manual Deploy

After pushing to GitHub, deploy manually on the VPS if you are not using GitHub Actions:

```bash
cd "/home/marsel/private app/reed-cloud-sec"
npm run check
bash scripts/deploy-vps.sh
```

The `npm run check` command validates the Node server used by the VPS. The Cloudflare Pages Function under `functions/` uses Cloudflare-specific imports and is not executed by the VPS runtime.

## GitHub Actions Deployment

The `Deploy VPS` workflow is manual by default. Run it from the GitHub Actions tab after the VPS deploy key and repository secrets are configured. This avoids failed automatic deploys while the server-side access controls are still being prepared.

The workflow deploys by copying the GitHub Actions checkout to the VPS over SSH with `rsync`, then running the local deploy script. This avoids storing GitHub repository credentials on the VPS.

Required GitHub repository secrets:

```text
VPS_HOST
VPS_USER
VPS_SSH_KEY
VPS_HOST_KEY
DEPLOY_PATH
```

Recommended values:

```text
VPS_HOST=2.25.143.61
VPS_USER=marsel
DEPLOY_PATH=/home/marsel/private app/reed-cloud-sec
```

`VPS_SSH_KEY` should be a private deploy key that can SSH into the VPS. Prefer a non-root deploy user. If that user is not root, grant only the narrow passwordless sudo command needed to restart and inspect the site service:

```text
marsel ALL=(root) NOPASSWD: /bin/systemctl restart reed-cloud-sec, /bin/systemctl --no-pager --full status reed-cloud-sec
```

`VPS_HOST_KEY` should be the server's SSH host key, collected from a trusted terminal with:

```bash
ssh-keyscan -t ed25519 2.25.143.61
```

Use a GitHub production environment approval gate if you want manual approval before deployments.
