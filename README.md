<p align="center">
  <img src="docs/logo.svg" alt="Nora Shillings" width="56" height="56">
</p>

<h1 align="center">Nora Shillings</h1>

<p align="center">
  <strong>Private payment infrastructure for every platform.</strong><br>
  A digital wallet and business toolkit — 100 NSH = 1 USD.
</p>

<p align="center">
  <a href="https://norashillings.benuru.com"><img src="https://img.shields.io/badge/live-norashillings.benuru.com-111?style=flat-square" alt="Live site"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://vercel.com"><img src="https://img.shields.io/badge/deploy-Vercel-000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel"></a>
  <img src="https://img.shields.io/badge/identity-Didit-0A7CFF?style=flat-square" alt="Didit">
  <img src="https://img.shields.io/badge/db-Neon%20Postgres-00E699?style=flat-square&logo=postgresql&logoColor=white" alt="Neon">
</p>

<p align="center">
  <a href="https://norashillings.benuru.com">Open the wallet</a> ·
  <a href="https://norashillings.benuru.com/docs">API docs</a> ·
  <a href="https://norashillings.benuru.com/product">Product</a> ·
  <a href="https://norashillings.benuru.com/about">About</a>
</p>

---

<p align="center">
  <img src="docs/architecture.jpg" alt="Nora Shillings architecture: customers, business tools, and platform rails" width="920">
</p>

## What it is

Nora Shillings is a live payments product:

- **Wallet** — add money, send, pay, and withdraw
- **Business tools** — API keys, hosted checkout, deposits, apps, and webhooks
- **Identity** — one free ID + selfie check (Didit) before withdrawals and live keys
- **Rails** — PayPal, card, and M-Pesa where configured

The buyer’s personal identity stays private. The company name is what checkout shows.

## Architecture

```mermaid
flowchart TB
  subgraph customers [Customers]
    W[Wallet]
    W --> Add[Add money]
    W --> Send[Send]
    W --> Pay[Pay]
    W --> Out[Withdraw]
  end

  subgraph business [Business tools]
    K[API keys]
    C[Checkout / deposits]
    H[Webhooks]
    A[Connected apps]
  end

  subgraph platform [Platform]
    ID[Didit identity]
    PP[PayPal]
    MP[M-Pesa]
    DB[(Neon Postgres)]
  end

  customers --> platform
  business --> platform
  platform --> DB
```

| Layer | Role |
| --- | --- |
| Wallet | Personal balances in Sandbox and Live |
| Business tools | Accept NSH, issue keys, deliver signed webhooks |
| Identity | Didit session → verified name & country on the account |
| Ledger | Append-only money movement in Postgres |

## Stack

- **Runtime** — Node.js serverless on Vercel (`api/nsh.js` router)
- **Data** — Neon Postgres
- **Auth** — email magic links, optional TOTP / passkeys
- **KYC** — Didit hosted verification
- **Payouts / top-ups** — PayPal and PayHero (M-Pesa) when env is set

## Quick start

```bash
git clone https://github.com/josephokero/nuru-shillings.git
cd nuru-shillings
cp .env.example .env   # fill in secrets locally — never commit .env
npm install
node scripts/migrate.mjs
node server.mjs        # http://localhost:8765
```

Required locally: `DATABASE_URL`, `NSH_ENC_KEY`, `APP_URL`.  
Optional: Didit, PayPal, PayHero, Resend, Bunny storage — see `.env.example`.

> **Security:** this repo ships with no API keys, database URLs, or webhook secrets. Keep production values in your host’s env store only.

## Repository layout

```
api/           Serverless handlers (wallet, KYC, pay, apps, security, admin)
scripts/       DB migrations and integration tests
*.html / *.js  Marketing site, wallet UI, business tools UI
docs/          Architecture art and brand assets for GitHub
```

## Founder

<p align="center">
  <img src="img/founder.jpg" alt="Joseph Nyarandi" width="160" height="200">
</p>

<p align="center">
  <strong>Joseph Nyarandi</strong> · Founder<br>
  Nora Shillings · founded June 2026<br>
  <a href="https://norashillings.benuru.com/about">About the team</a> ·
  <a href="mailto:norashillings@benuru.com">norashillings@benuru.com</a>
</p>

Director: **Emmanuel** — see the [About](https://norashillings.benuru.com/about) page.

## Contributing

Issues and thoughtful PRs are welcome. Do not open PRs that include `.env` files, keys, personal data, or production dumps.

## License

[MIT](LICENSE) © 2026 Joseph Nyarandi / Nora Shillings
