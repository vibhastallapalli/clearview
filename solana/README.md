# Solana (devnet only)

## CDT: the demo token

**CDT · ClearDock test dollars (devnet)** is a standard SPL token on Solana **devnet** with **2 decimals**, so 1 base unit = 1 cent and `amountMinor` maps 1:1 to token base units. It has no value. It is not USD and **never call it USDC**. Nothing here touches mainnet: the setup script checks the RPC's genesis hash and refuses to run on anything but devnet.

The basic payment demo needs only CDT plus two wallets. Escrow (below) is a separate stretch goal.

## Prerequisites

- Node 20+ and `npm install` at the repo root.
- `@solana/web3.js` and `@solana/spl-token` in `server/`. These are requested from the integrator; until merged, run `npm i --no-save @solana/web3.js@^1.98 @solana/spl-token@^0.4 -w server`.
- Two Phantom wallets switched to **devnet** (Phantom's developer settings: turn on testnet mode, pick Solana Devnet):
  - **buyer**: the café owner who signs payments
  - **supplier**: receives CDT
- Only their **public** addresses go into config. Never share a seed phrase or private key with anyone or any tool.

## Configuration (`.env` in the repo root)

| Variable | Meaning |
|---|---|
| `SOLANA_RPC_URL` | Devnet RPC, e.g. `https://api.devnet.solana.com`. A private RPC URL may contain an API key: don't share it. |
| `DEMO_TOKEN_MINT` | CDT mint address (public). |
| `VITE_DEMO_TOKEN_MINT` | Same mint, exposed to the browser. |
| `DEMO_BUYER_WALLET` | Buyer's Phantom **public** address. |
| `DEMO_SUPPLIER_WALLET` | Supplier's Phantom **public** address. Must match `walletAddress` in `shared/fixtures/supplier.json`. |
| `DEMO_MINT_AUTHORITY_PATH` | Optional. Path to the local mint-authority keypair. Default `solana/.keys/cdt-mint-authority.json`; relative paths resolve from the repo root. Setup tooling only: the server never needs it. |

To get a public address, open Phantom on devnet and copy the account's Solana address.

## Setup command

From `server/`:

```bash
npx tsx --env-file-if-exists=../.env scripts/setup-devnet.ts [--check] [--new-mint] [--buyer-target=1000]
```

(`npm run setup:devnet -w server -- <flags>` once the integrator adds the script.)

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
   - generates a separate mint-authority key in `solana/.keys/`
   - funds it with one devnet airdrop attempt if it has under 0.05 SOL
   - creates the 2-decimal mint (no freeze authority) and records its address in `solana/.keys/cdt-mint-address.txt`
   - creates both token accounts
   - mints 1000 CDT to the buyer
3. Paste the printed `DEMO_TOKEN_MINT` / `VITE_DEMO_TOKEN_MINT` / wallet lines into `.env` and share the **public** mint address with the team. The integrator sets `supplier.json`.
4. Give the buyer wallet some devnet SOL for fees (see below).
5. Run again with `--check`. It should end with `✓ Check passed: verified on devnet.`

## Reuse and replenish (every other time)

Run without `--new-mint`. The configured mint is reused and checked:

- it must exist
- it must be owned by the SPL Token program
- it must have 2 decimals

If any of those fail, the script stops and explains. It **never** silently creates a replacement. Starting over is explicit: clear `DEMO_TOKEN_MINT`, delete `solana/.keys/cdt-mint-address.txt`, run `--new-mint`, and tell everyone the new mint.

After demo payments, rerun (optionally with `--buyer-target=N`) to refill the buyer back to the target. Running it twice in a row does nothing the second time.

`POST /api/dev/reset` resets the app's seeded data only. It does **not** reset blockchain balances or erase transfers. Use this script to refill CDT.

## Where the mint authority lives

`solana/.keys/cdt-mint-authority.json` (gitignored), or wherever `DEMO_MINT_AUTHORITY_PATH` points. It is a throwaway devnet key that can mint CDT and pays setup fees. It is kept separate from the buyer and supplier wallets. The script never prints it.

- Only the person who created the mint has it. Others can still use existing CDT and run `--check`, but can't top up.
- If you work in a temporary git worktree, point `DEMO_MINT_AUTHORITY_PATH` at a path that outlives it. Deleting the key means CDT can never be minted again for that mint.

## Getting devnet SOL

- **Setup key:** the script requests 1 SOL once when it has under 0.05 SOL. If the airdrop is rate-limited, it prints the error and the key's public address, then stops before any on-chain change.
- **Buyer:** needs ~0.01+ SOL for fees. The script only checks this; fund it yourself.
- **Supplier:** needs no SOL.

To fund an address by hand, use https://faucet.solana.com (select Devnet, paste the **public** address). You can also run `solana airdrop 1 <address> -u devnet` if you have the Solana CLI. Faucets are rate-limited, so wait or have a teammate request instead of retrying in a loop.

## Expected output

```
✓ RPC api.devnet.solana.com is Solana devnet
+ created CDT mint <MINT> (recorded in .../solana/.keys/cdt-mint-address.txt)
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
...
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
