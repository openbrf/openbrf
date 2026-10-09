-- A board recorded on a vacant register by somebody who holds no seat is its
-- own act, so it is recorded under its own action rather than as an election
-- the board recorded. GLOSSARY, board recovery.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BOARD_RECOVERY_RECORDED';
