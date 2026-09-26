# Solana (devnet only)

## CDT: the demo token

**CDT · ClearDock test dollars (devnet)** is a standard SPL token on Solana **devnet** with **2 decimals**, so 1 base unit = 1 cent and `amountMinor` maps 1:1 to token base units. It has no value. It is not USD and **never call it USDC**. Nothing here touches mainnet: the setup script checks the RPC's genesis hash and refuses to run on anything but devnet.

The basic payment demo needs only CDT plus two wallets. Escrow (below) is a separate stretch goal.

## Prerequisites

- Node 20+ and `npm install` at the repo root.
- Two Phantom wallets switched to **devnet** (Phantom's developer settings: turn on testnet mode, pick Solana Devnet):
  - **buyer**: the café owner who signs payments
  - **supplier**: receives CDT
- Only their **public** addresses go into config. Never share a seed phrase or private key with anyone or any tool.

## Configuration (`.env` in the repo root)

| Variable | Meaning |
|---|---|
| `SOLANA_RPC_URL` | Devnet RPC, e.g. `https://api.devnet.solana.com`. A private RPC URL may contain an API key: don't share it. |
| `DEMO_TOKEN_MINT` | CDT mint address (public). The only mint setting: the browser reads it from `GET /api/config`. |
| `DEMO_BUYER_WALLET` | Buyer's Phantom **public** address. |
| `DEMO_SUPPLIER_WALLET` | Supplier's Phantom **public** address. The server seeds the demo supplier's verified wallet from it, overriding the fixture. After changing it, run `POST /api/dev/reset`. |
| `DEMO_MINT_AUTHORITY_PATH` | Path to the mint-authority keypair. The team's key is at `C:\Users\vibha\.cleardock\cdt-mint-authority.json`, outside every checkout. If unset, it defaults to `solana/.keys/cdt-mint-authority.json` (gitignored); relative paths resolve from the repo root. Setup tooling only: the server never reads it. |

To get a public address, open Phantom on devnet and copy the account's Solana address.

## Setup command

From the repo root:

```bash
npm run setup:devnet -w server -- [--check] [--new-mint] [--buyer-target=1000]
```

It reads the root `.env`. Values already set in the shell take priority.

| Flag | Effect |
|---|---|
| *(none)* | Verify the configured mint. Create any missing buyer/supplier CDT token accounts. Top the buyer up to the target. |
| `--check` | Read-only: verify everything, change nothing. |
| `--new-mint` | Create the CDT mint. Refused if `DEMO_TOKEN_MINT` is set or a mint is already recorded next to the authority key (`cdt-mint-address.txt`). |
| `--buyer-target=N` | Target buyer balance in **whole CDT** (integer, default 1000). Mints only `N − current`. Never mints above it, never burns. |

The script only reads `.env`; it never edits it. It prints the lines to paste.

## First-time setup (create the mint)

1. Fill `DEMO_BUYER_WALLET` and `DEMO_SUPPLIER_WALLET` in `.env`. Leave `DEMO_TOKEN_MINT` empty.
2. Run with `--new-mint`. The script then:
   - generates a separate mint-authority key at `DEMO_MINT_AUTHORITY_PATH`, if none exists there yet
   - funds it with one devnet airdrop attempt if it has under 0.05 SOL
   - creates the 2-decimal mint (no freeze authority) and records its address in `cdt-mint-address.txt`, next to the key
   - creates both token accounts
   - mints 1000 CDT to the buyer
3. Paste the printed `DEMO_TOKEN_MINT` / wallet lines into `.env` and share the **public** mint address with the team. If the server was already running, restart it and run `POST /api/dev/reset` so the supplier wallet is re-seeded from `DEMO_SUPPLIER_WALLET`.
4. Give the buyer wallet some devnet SOL for fees (see below).
5. Run again with `--check`. It should end with `✓ Check passed: verified on devnet.`

## Reuse and replenish (every other time)

Run without `--new-mint`. The configured mint is reused and checked:

- it must exist
- it must be owned by the SPL Token program
- it must have 2 decimals

If any of those fail, the script stops and explains. It **never** silently creates a replacement. Starting over is explicit: clear `DEMO_TOKEN_MINT`, delete `cdt-mint-address.txt` next to the authority key, run `--new-mint`, and tell everyone the new mint.

After demo payments, rerun (optionally with `--buyer-target=N`) to refill the buyer back to the target. Running it twice in a row does nothing the second time.

`POST /api/dev/reset` resets the app's seeded data only. It does **not** reset blockchain balances or erase transfers. Use this script to refill CDT.

## Where the mint authority lives

The team's key is at `C:\Users\vibha\.cleardock\cdt-mint-authority.json` (set it in `DEMO_MINT_AUTHORITY_PATH`). That's outside every checkout, so cleaning up a worktree can't delete it. Without the variable, the script falls back to `solana/.keys/cdt-mint-authority.json` (gitignored). It is a throwaway devnet key that can mint CDT and pays setup fees. It is kept separate from the buyer and supplier wallets. The script never prints it.

- Only the person who created the mint has it. Others can still use existing CDT and run `--check`, but can't top up.
- Deleting the key means CDT can never be minted again for that mint. Keep it outside any checkout, or only under the gitignored `solana/.keys/`.

## Getting devnet SOL

- **Setup key:** the script requests 1 SOL once when it has under 0.05 SOL. If the airdrop is rate-limited, it prints the error and the key's public address, then stops before any on-chain change.
- **Buyer:** needs ~0.01+ SOL for fees. The script only checks this; fund it yourself.
- **Supplier:** needs no SOL.

To fund an address by hand, use https://faucet.solana.com (select Devnet, paste the **public** address). You can also run `solana airdrop 1 <address> -u devnet` if you have the Solana CLI. Faucets are rate-limited, so wait or have a teammate request instead of retrying in a loop.

## Expected output

```
✓ RPC api.devnet.solana.com is Solana devnet
+ created CDT mint <MINT> (recorded in C:\Users\vibha\.cleardock\cdt-mint-address.txt)
✓ mint <MINT>: SPL Token program, 2 decimals, supply 0.00 CDT
+ created Buyer CDT token account <BUYER_ATA>
+ created Supplier CDT token account <SUPPLIER_ATA>
+ minted 1000.00 CDT to buyer (tx https://explorer.solana.com/tx/<SIG>?cluster=devnet)

CDT · ClearDock test dollars (devnet)
  Mint              <MINT>
  Mint authority    <AUTHORITY_PUBKEY>  (key available locally)
  Buyer wallet      <BUYER>  0.5000 SOL
  Buyer CDT acct    <BUYER_ATA>  1000.00 CDT
  Supplier wallet   <SUPPLIER>  0.0000 SOL
  Supplier CDT acct <SUPPLIER_ATA>  0.00 CDT
  Explorer          https://explorer.solana.com/address/<MINT>?cluster=devnet

.env values (public, safe to share):
DEMO_TOKEN_MINT=<MINT>
DEMO_BUYER_WALLET=<BUYER>
DEMO_SUPPLIER_WALLET=<SUPPLIER>
(the server seeds the supplier wallet from DEMO_SUPPLIER_WALLET; after changing it, POST /api/dev/reset)
✓ Setup done: verified on devnet.
```

Lines starting with `+` are on-chain changes made in this run. `!` lines are notes and `✗` lines are problems. The exit code is non-zero if anything is incomplete.

## Troubleshooting

| Message | Fix |
|---|---|
| `not Solana devnet` | `SOLANA_RPC_URL` points at mainnet/testnet/localnet. Use a devnet endpoint. |
| `Cannot reach RPC` | Network or URL problem. Check `SOLANA_RPC_URL`. |
| `Devnet airdrop failed` (429 / rate limit) | Fund the printed setup-key address at faucet.solana.com, then rerun. |
| `Buyer wallet has 0.0000 SOL` | Fund the buyer's public address at the faucet. |
| `DEMO_TOKEN_MINT ... does not exist` | Typo, a mainnet address, or a mint from a wiped devnet. Fix it, or start over (see above). |
| `has 6 decimals; CDT must have 2` | Wrong mint (e.g. a devnet USDC-style mint). Use the CDT mint. |
| `not the SPL Token program` | Token-2022 or another program's account. CDT must be a standard SPL token. |
| `is not a wallet address` | You pasted a token account, not the Phantom wallet address. |
| `No mint authority key` / `not this mint's authority` | You aren't the machine that created the mint. Existing CDT works; ask the key holder to top up. |
| `DEMO_TOKEN_MINT is not set, but this key already created mint X` | Paste `DEMO_TOKEN_MINT=X` into `.env`. |

## Solana Explorer

Always add `?cluster=devnet`:

- **Address or token account:** `https://explorer.solana.com/address/<ADDRESS>?cluster=devnet`
- **Mint:** the same URL shows decimals, supply and mint authority.
- **Transaction:** `https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`

## Escrow (stretch, separate from the basic demo)

Rules: [../docs/escrow-rulebook.md](../docs/escrow-rulebook.md). Anchor program, minimal instructions:

| Instruction | Signer | Effect |
|---|---|---|
| `fund` | buyer | lock order amount; store supplier address + terms hash |
| `accept_all` | buyer | release everything to stored supplier |
| `claim` | buyer | release accepted part now, lock claimed part |
| `settle` | buyer **and** supplier | pay out the split both signed (must sum to locked amount) |

Must fail: wrong signer, changed destination, second payout, settlement that doesn't sum.
