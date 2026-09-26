use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Escrow11111111111111111111111111111111111");

/// ClearDock order escrow (Phase 2, devnet only).
///
/// Rules (docs/escrow-rulebook.md): only signatures move money. A claim can
/// lock disputed funds but never refunds itself; only `settle`, signed by
/// both buyer and supplier, can release claimed/locked funds to either side.
#[program]
pub mod escrow {
    use super::*;

    /// Buyer signs. Locks `amount` of `mint` in a program-owned vault for
    /// `supplier`. `order_id_hash` is a sha256 of the order reference used
    /// as a PDA seed so one buyer can fund multiple orders concurrently.
    pub fn fund(
        ctx: Context<Fund>,
        order_id_hash: [u8; 32],
        amount: u64,
        supplier: Pubkey,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.supplier = supplier;
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.order_id_hash = order_id_hash;
        escrow.terms_hash = terms_hash;
        escrow.total_amount = amount;
        escrow.released_amount = 0;
        escrow.claimed_amount = 0;
        escrow.refunded_amount = 0;
        escrow.status = EscrowStatus::Funded;
        escrow.bump = ctx.bumps.escrow;
        Ok(())
    }

    /// Buyer signs only. Releases the entire remaining vault balance to the
    /// stored supplier. Fails for any other signer or if funds already moved.
    pub fn accept_all(ctx: Context<ReleaseToSupplier>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);

        let amount = ctx.accounts.vault.amount;
        require!(amount > 0, EscrowError::InvalidAmount);

        let seeds = escrow_signer_seeds(escrow);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.supplier_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount += amount;
        escrow.status = EscrowStatus::Released;
        Ok(())
    }

    /// Buyer signs. Releases `accepted_amount` to the supplier now and keeps
    /// `claimed_amount` locked pending settlement. The two must exactly
    /// account for the remaining vault balance.
    pub fn claim(ctx: Context<Claim>, accepted_amount: u64, claimed_amount: u64) -> Result<()> {
        let remaining = ctx.accounts.vault.amount;
        require!(
            accepted_amount
                .checked_add(claimed_amount)
                .ok_or(EscrowError::InvalidAmount)?
                == remaining,
            EscrowError::AmountMismatch
        );
        {
            let escrow = &ctx.accounts.escrow;
            require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidStatus);
        }

        if accepted_amount > 0 {
            let seeds = escrow_signer_seeds(&ctx.accounts.escrow);
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.supplier_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                accepted_amount,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount += accepted_amount;
        escrow.claimed_amount = claimed_amount;
        escrow.status = EscrowStatus::Claimed;
        Ok(())
    }

    /// Requires BOTH buyer and supplier signatures on the same transaction.
    /// `to_supplier + to_buyer` must equal the currently locked claimed
    /// amount exactly. Pays out both parts in one instruction; each order
    /// can only be settled once (status guard below).
    pub fn settle(ctx: Context<Settle>, to_supplier: u64, to_buyer: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Claimed, EscrowError::InvalidStatus);
        require!(
            to_supplier
                .checked_add(to_buyer)
                .ok_or(EscrowError::InvalidAmount)?
                == escrow.claimed_amount,
            EscrowError::AmountMismatch
        );

        let seeds = escrow_signer_seeds(escrow);

        if to_supplier > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.supplier_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                to_supplier,
            )?;
        }

        if to_buyer > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.buyer_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                to_buyer,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount += to_supplier;
        escrow.refunded_amount += to_buyer;
        escrow.claimed_amount = 0;
        escrow.status = EscrowStatus::Settled;
        Ok(())
    }
}

fn escrow_signer_seeds(escrow: &Account<Escrow>) -> [Vec<u8>; 4] {
    [
        b"escrow".to_vec(),
        escrow.buyer.as_ref().to_vec(),
        escrow.order_id_hash.to_vec(),
        vec![escrow.bump],
    ]
}

#[derive(Accounts)]
#[instruction(order_id_hash: [u8; 32])]
pub struct Fund<'info> {
    #[account(
        init,
        payer = buyer,
        space = Escrow::SIZE,
        seeds = [b"escrow", buyer.key().as_ref(), order_id_hash.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = escrow,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut, constraint = buyer_token_account.mint == mint.key())]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseToSupplier<'info> {
    #[account(
        mut,
        has_one = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.order_id_hash.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, address = escrow.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = supplier_token_account.owner == escrow.supplier @ EscrowError::WrongDestination,
        constraint = supplier_token_account.mint == escrow.mint @ EscrowError::WrongDestination
    )]
    pub supplier_token_account: Account<'info, TokenAccount>,

    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.order_id_hash.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, address = escrow.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = supplier_token_account.owner == escrow.supplier @ EscrowError::WrongDestination,
        constraint = supplier_token_account.mint == escrow.mint @ EscrowError::WrongDestination
    )]
    pub supplier_token_account: Account<'info, TokenAccount>,

    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        has_one = buyer,
        has_one = supplier,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.order_id_hash.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, address = escrow.vault)]
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

    /// Buyer must co-sign the settlement.
    pub buyer: Signer<'info>,

    /// Supplier must co-sign the settlement. Both signatures are required by
    /// the runtime because both are declared `Signer` here.
    pub supplier: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Escrow {
    pub buyer: Pubkey,
    pub supplier: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub order_id_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub total_amount: u64,
    pub released_amount: u64,
    pub claimed_amount: u64,
    pub refunded_amount: u64,
    pub status: EscrowStatus,
    pub bump: u8,
}

impl Escrow {
    // discriminator(8) + 4 pubkeys(32*4) + 2 hashes(32*2) + 4 u64(8*4) + status(1) + bump(1)
    pub const SIZE: usize = 8 + 32 * 4 + 32 * 2 + 8 * 4 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
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
    #[msg("Escrow is not in the expected status for this action")]
    InvalidStatus,
    #[msg("Amounts do not sum to the locked amount")]
    AmountMismatch,
    #[msg("Destination token account does not match the stored recipient")]
    WrongDestination,
}
