Fixture respons StonkFun Developer API (`https://www.stonkfun.xyz/api/public/v1`).

- `pricing-sol-mainnet-2026-10-31.json` — respons ASLI `GET /launchlab/pricing?quoteMint=SOL`,
  diambil pemilik pada 2026-10-31 (hanya daftar `communityMode.quotes` yang dipangkas). Ini acuan
  bentuk & nilai pricing: `raise.raw` berupa string mentah (bukan objek), `quote.{mint,decimals,
tokenProgram}`, `allowConfig` (required/available/alamat per mode), `curveRule`, `marketCap`,
  `curve.derived`, `modes.standard.transferFee: null`. Fixture pricing lama yang disusun dari
  dokumen (`pricing-sol.json`) dihapus karena bentuk & nilainya salah.
- `token-adopted.json` — respons ASLI `GET /tokens/{mint}` untuk PunkDuck, diambil 2026-11-03.
  Isinya `data.token` + `data.launch`, bukan field langsung di `data`. Mint yang bukan pool
  platform dibalas 404.
- File lain (`pairs`, `launches`, `fees-*`, `error-rate-limited`) masih disusun
  dari spesifikasi OpenAPI resmi (`/api/public/v1/openapi.json`, v1.0.0, diambil 2026-10-31):
  skema OpenAPI hanya menyatakan amplop `{ data, meta }` / `{ error: { code, message, retryable,
retryAfterSeconds } }`, jadi isi `data` mengikuti field yang DISEBUT di deskripsi endpoint.
  Alamat & angka di file-file itu BUKAN nilai asli; bentuk aslinya belum dikonfirmasi.
