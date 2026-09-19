# Muse Dogs Art Pose Audit — ai-76 through ai-475

Date: 2026-09-18 (PDT)
Auditor: subagent (read-only on images; nothing modified)
Template: `workspace/user/media_library/image/b5/b53bd8477ae10612690e08d5306ecb32080f82a0e44f7bf1ce3031c95d7855b9.jpg`

## Hard rule applied

EXACT same stance, pose, and position in frame for every piece:

- Medium shot, dog centered
- Head + upper torso visible
- Facing camera directly
- Symmetrical floppy ears
- Same size and position in every image
- Light inner face panel regardless of fur color (fail any concept where the face is tinted to match the fur)

## Method

1. Reviewed all 400 thumbnails (300x300 webp) in four labeled 10x10 contact sheets — full coverage, one cell per concept, each cell labeled with its concept number.
2. Verified the numbering was complete: exactly ai-76 through ai-475, 400/400 files present in both `thumbs/` and `full/`. No missing files, no unreadable files, no non-dog images.
3. Ran 12 full-size (1600x1600) spot checks at 800px on the highest-risk concepts — deliberately biased toward tinted-face risk (strong/red/black/green/rainbow fur) and pose drift: ai-76, ai-86, ai-99, ai-104, ai-150, ai-162, ai-247, ai-274, ai-319, ai-388, ai-458, ai-475. All 12 passed pose, framing, symmetry, and face-panel checks at full resolution.

Note: the one-line reasons below use the fail taxonomy from the task (pose rotated, off-center, tighter crop, face tinted, ears asymmetrical, body redrawn). No concept met any fail condition.

## Totals

- Concepts audited: 400 (ai-76 to ai-475)
- PASS: 400
- FAIL: 0

## Complete FAIL list

None. Zero fails.

Everything unlisted in this report passed. The FAIL list above is intentionally empty — that IS the complete list, not a truncation.

## Full-size spot checks (all PASS)

- ai-76 businessman suit — front-facing, centered, symmetric ears, light face panel. PASS.
- ai-86 astronaut (white) — same pose/framing; helmet bubble does not move the dog. PASS.
- ai-99 skier — teal fur, face light, symmetric. PASS.
- ai-104 crown — cream fur, face light, symmetric. PASS.
- ai-150 alien (green fur) — face stays light cream, symmetric. PASS.
- ai-162 punk (red/black fur) — face stays light, symmetric. PASS.
- ai-247 panda — black/white fur, face light, symmetric. PASS.
- ai-274 moon astronaut — gray fur, face light, symmetric. PASS.
- ai-319 watchmaker (navy fur) — face light, symmetric. PASS.
- ai-388 rainbow clown — rainbow fur, face stays light cream, symmetric. PASS.
- ai-458 holi festival — rainbow paint on fur/outfit, face stays light, symmetric. PASS.
- ai-475 office (black fur) — face light, symmetric. PASS.

## Observations for the best-of-the-best cull (not fails)

1. **Multicolor fur outliers** — the standing art rule is one or two fur colors per concept. These two go beyond that and should be decided individually when picking the 333:
   - ai-388 (rainbow clown — full rainbow gradient fur)
   - ai-458 (holi festival — rainbow paint across fur/outfit)
   Neither violates the pose rule or the light-face-panel rule.
2. **Accessory asymmetry is fine** — several concepts hold one-sided props (telescope ai-113, guitar ai-158/ai-161, mic ai-159, magnifier ai-319). The dog's stance, pose, and frame position remain exact; the props ride along with the concept and do not break the rule.
3. **Helmet/hat framing** — concepts with tall headwear (ai-274, ai-86, ai-404 hockey, ai-418, ai-399 ski goggles) keep the same body framing; headwear sits above the dog without shifting the dog itself.
4. **Fluff level** — the batch reads as sleek/smooth plush, consistent with the post-2026-09-17 rule. No obvious fluff violations spotted at review scale.

## Verdict

The entire ai-76..ai-475 batch is pose-consistent with the template. No regenerations required on pose grounds. If the 333-piece plan drops the multicolor outliers, that is an art-direction call, not an audit failure.
