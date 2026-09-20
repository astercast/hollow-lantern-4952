# Verified pool keys for MuseDogsFeeSplitter deploy (Robinhood Chain 4663)

Pool key = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) must equal the live pool id.
Env names match script/Deploy.s.sol.

## musebook/META — Pool B (Andrew's pick, 2026-09-20 ~04:05 PDT)
- META_MUSEBOOK_FEE=9000
- META_MUSEBOOK_TICK_SPACING=90
- META_MUSEBOOK_HOOKS=0x0000000000000000000000000000000000000000
- currency0 = musebook 0x91a2dae9699f0b82540b5886b0d8759c22820ba3
- currency1 = META 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35
- Live pool id: 0x4dccc74f95feac0f9ec3f92f0868c32ad90b2ad335b19701b7b14574fecfab44
- Key hash recomputed 2026-09-20: MATCHES live pool id. Fixed 0.9% fee, no hook.

## MDOG/musebook — our pool (created 2026-09-20)
- MDOG_MUSEBOOK_FEE=3000 (default in script, already correct)
- MDOG_MUSEBOOK_TICK_SPACING=60 (default, correct)
- MDOG_MUSEBOOK_HOOKS=0x0000000000000000000000000000000000000000 (default, correct)
- Pool id: 0x7edc541fce494a314d0eb46410581208b1ca24d8e8e20bd3b7d666e1258fa1b0

## NOT YET VERIFIED — resolve against live chain before deploy
None remaining — all five route pools verified 2026-09-20 (see below).

## native/META — ETH→META hop (verified live 2026-09-20)
- META_ETH_FEE=9000
- META_ETH_TICK_SPACING=90
- META_ETH_HOOKS=0x0000000000000000000000000000000000000000
- currency0 = native (address 0), currency1 = META 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35
- Live pool id: 0x0517b876fc82b3494abc9c208d5873d4b515d1761351d7d0264840551f56cc48
- Key hash recomputed: MATCHES. Chosen as the most liquid of 19 native/META pools
  (liquidity 8.46e19, ~2.5x the runner-up at 3.38e19 which is a 4.8%/480 pool).
  Fixed 0.9% fee, no hook.

## MDOG/META — META→MDOG hop, the Pons pool (verified live 2026-09-20)
- META_MDOG_FEE=0
- META_MDOG_TICK_SPACING=200
- META_MDOG_HOOKS=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
- currency0 = MDOG 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC,
  currency1 = META 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35
- Live pool id: 0xd1fc0038c1422034f23e35bbab6b265574733c2c64ee6514f2849d3b0fb23665
- Key hash recomputed: MATCHES. Only ONE MDOG/META pool exists on-chain — no
  ambiguity. fee=0 is intentional: the Pons hook takes ~2% (1% creator tax + 1%
  hook fee) via afterSwap. Compatible with the splitter's _validatePoolKey
  (fee=0 allowed when a hook is set).

## native/MDOG — direct MDOG/ETH route (verified live 2026-09-20)
- MDOG_ETH_FEE=3000
- MDOG_ETH_TICK_SPACING=60
- MDOG_ETH_HOOKS=0x0000000000000000000000000000000000000000
- currency0 = native (address 0), currency1 = MDOG 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC
- Live pool id: 0x2c4b65a41f07637153dab0ca3d9e4ccd91b7a310c3091a032c9f6a430a355d75
- Key hash recomputed: MATCHES. Most liquid of 3 native/MDOG pools
  (liquidity 3.8345e20; runner-up 6.75e17 at 79%/60; third has 0 liquidity).
  NOTE: this is the same pool as Andrew's personal position NFT #2864985
  (on-chain liquidity exactly equals the post-withdrawal 383452300617780678893).
  The splitter mints a NEW dead-address position here; it never touches his NFT,
  but both positions will share the pool.
