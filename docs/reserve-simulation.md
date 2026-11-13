# Simulasi parameter Conviction Reserve (Spec §12) — Tahap 8

Spec §12 menyebut threshold $250, maksimum 25% per siklus, dan cooldown 24 jam sebagai **asumsi awal yang wajib divalidasi lewat simulasi dan testing**. Dokumen ini mencatat backtest sederhana atas parameter itu.

Cara menjalankan (deterministik, 20 seed per baris): `pnpm --filter @liftoff/worker reserve:sim` (`apps/worker/src/sim/reserve-sim.ts`). Simulasi memakai `evaluateReserveDeployment` yang sama dengan worker, sehingga semua market safety check §12 dan batas tambahan ikut berlaku.

## Model

- 180 hari per jam setelah graduation. Pool CPMM x·y = k, sisi quote awal = target graduation `CURVE_TARGET.graduationUsd` ($12.000).
- Volume per jam lognormal (σ ≈ 0,8) di sekitar turnover harian × likuiditas; fee pool 0,25% + creator fee 0,25%. 20% creator fee masuk reserve token itu.
- Skenario: `steady` (tanpa drift, turnover 50%/hari), `declining` (tekanan jual, turnover 30%), `crash` (drift turun + tiga dump −40% dalam satu jam), `pump` (tekanan beli, turnover 120%).
- Deployment: ≤ pct saldo, ≤ $5.000, ≤ 20% pool; separuh ditukar ke token, lalu keduanya ditambahkan ke pool (LP dibakar).
- Batasan model: harga USD diasumsikan tetap, tidak ada arbitrase eksternal, tidak ada likuiditas pihak ketiga, volume sintetis. Hasilnya menguji **konsistensi aturan**, bukan memprediksi pasar.

## Hasil

| Variant                 | Scenario  | Deploys/180d | Deployed USD | Max impact (bps) | Deploys in abnormal hour | Avg idle reserve while thin (USD) | Reserve share of pool |
| ----------------------- | --------- | ------------ | ------------ | ---------------- | ------------------------ | --------------------------------- | --------------------- |
| Spec ($250 · 25% · 24h) | steady    | 9.5          | 594          | 50               | 0                        | 178                               | 2.22%                 |
| Spec ($250 · 25% · 24h) | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| Spec ($250 · 25% · 24h) | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| Spec ($250 · 25% · 24h) | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| threshold $100          | steady    | 29.1         | 729          | 23               | 0                        | 81                                | 2.73%                 |
| threshold $100          | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| threshold $100          | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| threshold $100          | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| threshold $1,000        | steady    | 0.1          | 25           | 59               | 0                        | 348                               | 0.05%                 |
| threshold $1,000        | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| threshold $1,000        | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| threshold $1,000        | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| max 10%/cycle           | steady    | 23.0         | 576          | 20               | 0                        | 190                               | 2.14%                 |
| max 10%/cycle           | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| max 10%/cycle           | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| max 10%/cycle           | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| max 50%/cycle           | steady    | 5.0          | 632          | 94               | 0                        | 158                               | 2.36%                 |
| max 50%/cycle           | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| max 50%/cycle           | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| max 50%/cycle           | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| cooldown 6h             | steady    | 9.5          | 594          | 50               | 0                        | 178                               | 2.22%                 |
| cooldown 6h             | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| cooldown 6h             | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| cooldown 6h             | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |
| cooldown 72h            | steady    | 9.5          | 594          | 50               | 0                        | 178                               | 2.22%                 |
| cooldown 72h            | declining | 0.0          | 0            | 0                | 0                        | 19                                | 0.00%                 |
| cooldown 72h            | crash     | 0.0          | 0            | 0                | 0                        | 52                                | 0.00%                 |
| cooldown 72h            | pump      | 0.0          | 0            | 0                | 0                        | 24                                | 0.00%                 |

## Kesimpulan

1. **Keamanan aturan terpenuhi.** Dampak harga swap deployment maksimum 50 bps (batas 150 bps) dengan 25% per siklus; 0 deployment di jam dengan gerak > 30% (pemeriksaan "abnormal pool state" bekerja di skenario crash). Pool di atas $50.000 (skenario pump) tidak menerima deployment, sesuai kondisi likuiditas §12.
2. **25% per siklus wajar.** 10% menghasilkan lebih banyak deployment kecil dengan total serupa; 50% menaikkan dampak harga (94 bps) tanpa menambah banyak likuiditas.
3. **Cooldown 24 jam tidak pernah menjadi faktor pembatas** pada skala ini (6 jam, 24 jam, 72 jam memberi hasil identik). Yang membatasi adalah threshold $250: pada pool graduation $12.000, reserve hanya bertambah ±0,05% dari volume.
4. **Threshold $250 membuat mekanisme jarang aktif.** Di skenario `steady` rata-rata ±$178 reserve menganggur saat pool tipis; di skenario `declining` (justru saat likuiditas paling dibutuhkan) reserve tidak pernah mencapai $250 maupun $100 karena volume dan fee terlalu kecil. Hasil ini tidak cukup mendukung untuk menyatakan threshold sudah tervalidasi.

**Keputusan:** `RESERVE_CONFIG.status` tetap `unverified`. Parameter tetap nilai Spec (tidak ada perubahan tanpa persetujuan pemilik). Keputusan yang dibutuhkan pemilik: apakah threshold diturunkan (mis. $100 melipatgandakan deployment dengan dampak harga lebih kecil), dan apakah validasi lanjutan memakai data volume mainnet/StonkFun nyata.

## Pembaruan 2026-10-31 — ukuran graduation StonkFun asli

Respons asli `GET /launchlab/pricing?quoteMint=SOL` (pemilik, 2026-10-31; `packages/shared/src/__fixtures__/stonkfun/pricing-sol-mainnet-2026-10-31.json`) memberi:

- **Raise graduation = 85 SOL** (`raise.raw` 85 000 000 000 lamport) ≈ **$8.146** pada harga SOL teramati $95,84. Ini yang masuk ke sisi quote pool CPMM saat migrasi (`migrateFeeRaw` 0).
- **Market cap graduation ≈ $39.375** (`marketCap.graduationUsd`, 14,7× market cap awal $2.680).

Catatan penting: `CURVE_TARGET.graduationUsd` ($12.000) di model LIFTOFF adalah **raise** (sisi quote pool), bukan market cap. Jadi pembanding yang setara untuk StonkFun adalah raise **±$8,1k** — pool graduation StonkFun asli justru **lebih kecil** daripada emulasi devnet ($12k), walau market cap graduation-nya ($39k) jauh lebih besar dari $12k.

Simulasi ulang dengan ukuran pool awal tersebut (`pnpm --filter @liftoff/worker reserve:sim --graduation-usd=<USD>`; parameter `RESERVE_CONFIG` TIDAK diubah):

| Pool awal (sisi quote)             | Variant                 | Scenario  | Deploys/180d | Deployed USD | Max impact (bps) | Avg idle reserve while thin (USD) |
| ---------------------------------- | ----------------------- | --------- | ------------ | ------------ | ---------------- | --------------------------------- |
| $12.000 (emulasi, tabel di atas)   | Spec ($250 · 25% · 24h) | steady    | 9.5          | 594          | 50               | 178                               |
| **$8.146 (raise StonkFun asli)**   | Spec ($250 · 25% · 24h) | steady    | 5.2          | 325          | 67               | 161                               |
| **$8.146 (raise StonkFun asli)**   | Spec ($250 · 25% · 24h) | declining | 0.0          | 0            | 0                | 13                                |
| **$8.146 (raise StonkFun asli)**   | Spec ($250 · 25% · 24h) | crash     | 0.0          | 0            | 0                | 35                                |
| **$8.146 (raise StonkFun asli)**   | threshold $100          | steady    | 18.8         | 469          | 33               | 78                                |
| $39.375 (salah tafsir: market cap) | Spec ($250 · 25% · 24h) | steady    | 9.3          | 595          | 22               | 179                               |

**Apakah threshold $250 lebih mudah tercapai?** Tidak. Di model ini reserve tumbuh sebanding volume, dan volume sebanding likuiditas pool; pool graduation StonkFun (±$8,1k) lebih kecil dari asumsi emulasi ($12k), sehingga deployment pada skenario `steady` turun dari 9,5 menjadi 5,2 per 180 hari, dan di skenario `declining` / `crash` reserve tetap tidak pernah mencapai $250. Bahkan bila pool dianggap $39k (salah tafsir market cap), jumlah deployment hampir tidak berubah karena batas likuiditas $50k dan arah pasar yang lebih menentukan. (Pada pool $39k dengan threshold $100, kolom "Reserve share of pool" skenario crash meledak karena pool menyusut sangat kecil setelah tiga dump −40% — artefak metrik, bukan deployment besar.)

**Keputusan:** tidak ada perubahan. `RESERVE_CONFIG` tetap $250 · 25% · 24 jam sesuai keputusan pemilik; status tetap `unverified`. Validasi sebenarnya butuh data volume StonkFun mainnet nyata.
