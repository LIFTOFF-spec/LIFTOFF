-- Global config LaunchLab per token (satu quote mint bisa punya lebih dari satu config, Tahap 1).
ALTER TABLE "tokens" ADD COLUMN "quoteConfigId" TEXT NOT NULL;
