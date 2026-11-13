-- StonkFun (strategi fee intake `forwarded`): creator fee yang diteruskan otomatis ke master
-- wallet dicatat sebagai operasi `fee_forward` (confirmed, diamati on-chain, tanpa tanda tangan).
ALTER TYPE "EconomicOpKind" ADD VALUE 'fee_forward';
