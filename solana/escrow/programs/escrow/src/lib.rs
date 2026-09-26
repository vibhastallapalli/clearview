use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("Bk4DD3mGCJRFATHTnLqyoxiWDm65nfMcPfE7oduiQzAt");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

/// ClearDock order escrow (devnet). Rules: docs/escrow-rulebook.md.
/// Only signatures move money: the buyer can accept or claim alone, but held
/// (claimed) funds leave the vault only through `settle`, signed by both parties.
#[program]
pub mod escrow {
    use super::*;

    /// Buyer locks `amount` of `mint` for `supplier`. `order_id_hash` is
    /// sha256(order reference) and seeds the escrow PDA.
    pub fn fund(
        ctx: Context<Fund>,
        order_id_hash: [u8; 32],
        amount: u64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require_keys_neq!(
            ctx.accounts.buyer.key(),
            ctx.accounts.supplier.key(),
            EscrowError::BuyerIsSupplier
        );

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.escrow.set_inner(Escrow {
            buyer: ctx.accounts.buyer.key(),
            supplier: ctx.accounts.supplier.key(),
            mint: ctx.accounts.mint.key(),
            vault: ctx.accounts.vault.key(),
            order_id_hash,
            terms_hash,
            total_amount: amount,
            released_amount: 0,
            claimed_amount: 0,
            refunded_amount: 0,
            status: EscrowStatus::Funded,
            bump: ctx.bumps.escrow,
        });

        msg!("ClearDock escrow funded: {} held for supplier {}", amount, ctx.accounts.supplier.key());
        Ok(())
    }

    /// Buyer accepts the whole delivery: everything goes to the stored supplier.
    pub fn accept_all(ctx: Context<Release>) -> Result<()> {
        let accounts = &ctx.accounts;
        require!(accounts.escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);
        let amount = accounts.escrow.locked()?;

        pay_from_vault(
            &accounts.token_program,
            &accounts.mint,
            &accounts.vault,
            &accounts.supplier_token_account,
            &accounts.escrow,
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount = checked_add(escrow.released_amount, amount)?;
        escrow.status = EscrowStatus::Released;

        msg!("ClearDock escrow: buyer accepted all, released {} to supplier", amount);
        Ok(())
    }

    /// Buyer accepts some lines and disputes the rest: `accepted_amount` pays the
    /// supplier now, `claimed_amount` stays held until both parties settle.
    pub fn claim(ctx: Context<Release>, accepted_amount: u64, claimed_amount: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        require!(accounts.escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);
        require!(claimed_amount > 0, EscrowError::InvalidAmount);
        require!(
            checked_add(accepted_amount, claimed_amount)? == accounts.escrow.locked()?,
            EscrowError::AmountMismatch
        );

        pay_from_vault(
            &accounts.token_program,
            &accounts.mint,
            &accounts.vault,
            &accounts.supplier_token_account,
            &accounts.escrow,
            accepted_amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount = checked_add(escrow.released_amount, accepted_amount)?;
        escrow.claimed_amount = claimed_amount;
        escrow.status = EscrowStatus::Claimed;

        msg!(
            "ClearDock escrow: released {} to supplier, {} held pending a settlement both sign",
            accepted_amount,
            claimed_amount
        );
        Ok(())
    }

    /// Executes a settlement both parties signed. The split must account for
    /// every held unit, and an escrow can only be settled once.
    pub fn settle(ctx: Context<Settle>, to_supplier: u64, to_buyer: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        require!(accounts.escrow.status == EscrowStatus::Claimed, EscrowError::InvalidStatus);
        require!(
            checked_add(to_supplier, to_buyer)? == accounts.escrow.locked()?,
            EscrowError::AmountMismatch
        );

        pay_from_vault(
            &accounts.token_program,
            &accounts.mint,
            &accounts.vault,
            &accounts.supplier_token_account,
            &accounts.escrow,
            to_supplier,
        )?;
        pay_from_vault(
            &accounts.token_program,
            &accounts.mint,
            &accounts.vault,
            &accounts.buyer_token_account,
            &accounts.escrow,
            to_buyer,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount = checked_add(escrow.released_amount, to_supplier)?;
        escrow.refunded_amount = checked_add(escrow.refunded_amount, to_buyer)?;
        escrow.status = EscrowStatus::Settled;

        msg!(
            "ClearDock escrow settled by buyer and supplier: {} to supplier, {} back to buyer",
            to_supplier,
            to_buyer
        );
        Ok(())
    }
}

fn pay_from_vault<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    escrow: &Account<'info, Escrow>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [escrow.bump];
    let seeds: [&[u8]; 4] = [ESCROW_SEED, escrow.buyer.as_ref(), &escrow.order_id_hash, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: escrow.to_account_info(),
            },
            &[&seeds[..]],
        ),
        amount,
        mint.decimals,
    )
}

fn checked_add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(EscrowError::Overflow))
}

#[derive(Accounts)]
#[instruction(order_id_hash: [u8; 32])]
pub struct Fund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: only this address is stored as the payout recipient; it does not sign or hold data.
    pub supplier: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, buyer.key().as_ref(), order_id_hash.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = escrow,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.buyer.as_ref(), escrow.order_id_hash.as_ref()],
        bump = escrow.bump,
        has_one = buyer @ EscrowError::Unauthorized,
        has_one = mint,
        has_one = vault
    )]
    pub escrow: Account<'info, Escrow>,

    pub buyer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = supplier_token_account.owner == escrow.supplier @ EscrowError::WrongDestination,
        constraint = supplier_token_account.mint == escrow.mint @ EscrowError::WrongDestination
    )]
    pub supplier_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.buyer.as_ref(), escrow.order_id_hash.as_ref()],
        bump = escrow.bump,
        has_one = buyer @ EscrowError::Unauthorized,
        has_one = supplier @ EscrowError::Unauthorized,
        has_one = mint,
        has_one = vault
    )]
    pub escrow: Account<'info, Escrow>,

    pub buyer: Signer<'info>,

    pub supplier: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = supplier_token_account.owner == escrow.supplier @ EscrowError::WrongDestination,
        constraint = supplier_token_account.mint == escrow.mint @ EscrowError::WrongDestination
    )]
    pub supplier_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == escrow.buyer @ EscrowError::WrongDestination,
        constraint = buyer_token_account.mint == escrow.mint @ EscrowError::WrongDestination
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Field order is part of the server's decoder (server/src/escrow.ts); append only.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub buyer: Pubkey,
    pub supplier: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub order_id_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub total_amount: u64,
    pub released_amount: u64,
    /// Amount the buyer disputed (history); what is still held is `locked()`.
    pub claimed_amount: u64,
    pub refunded_amount: u64,
    pub status: EscrowStatus,
    pub bump: u8,
}

impl Escrow {
    pub fn locked(&self) -> Result<u64> {
        self.total_amount
            .checked_sub(self.released_amount)
            .and_then(|rest| rest.checked_sub(self.refunded_amount))
            .ok_or_else(|| error!(EscrowError::Overflow))
    }
}

/// Variant order is part of the server's decoder; append only.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Funded,
    Claimed,
    Settled,
    Released,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Escrow is not in the right state for this action")]
    InvalidStatus,
    #[msg("Amounts must add up exactly to the held amount")]
    AmountMismatch,
    #[msg("Payout account does not belong to the stored recipient")]
    WrongDestination,
    #[msg("Signer is not the party stored on this escrow")]
    Unauthorized,
    #[msg("Buyer and supplier must be different wallets")]
    BuyerIsSupplier,
    #[msg("Arithmetic overflow")]
    Overflow,
}
