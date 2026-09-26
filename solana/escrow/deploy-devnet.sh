#!/usr/bin/env bash
# Deploys target/deploy/escrow.so to DEVNET. Run inside backpackapp/build:v0.30.1 with ~/.cleardock mounted at /k (see docs/escrow-status.md).
set -e
K=/k/escrow-deployer.json
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
[ "$(solana -ud genesis-hash)" = "$DEVNET_GENESIS" ] || { echo "NOT DEVNET"; exit 1; }
echo "network: devnet ($DEVNET_GENESIS)"
echo "deployer: $(solana-keygen pubkey $K)  balance: $(solana -ud balance $(solana-keygen pubkey $K))"
[ "$(solana-keygen pubkey /k/escrow-program-keypair.json)" = "Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt" ]
sha256sum /work/target/deploy/escrow.so
solana -ud -k $K program deploy /work/target/deploy/escrow.so --program-id /k/escrow-program-keypair.json --max-sign-attempts 50 --with-compute-unit-price 10000
solana -ud program show Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt
echo "balance after: $(solana -ud balance $(solana-keygen pubkey $K))"
