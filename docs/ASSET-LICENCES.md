# Asset licences

Every non-procedural (externally-sourced) art asset in this repo must have an entry here:
source, author, licence, and commercial-use status. This is miserable to reconstruct after the
fact — see docs/ARCHITECTURE.md's "Art direction" — so it is committed alongside the asset, not
written up after the fact.

Status legend:
- **CONFIRMED** — licence text read directly from the authoritative source (not just embedded
  metadata) by a human on this team, on this date.
- **LIKELY OK, NOT YET CONFIRMED BY A HUMAN** — strong automated evidence (embedded file
  metadata, cross-checked against the live source page), but no human has read the licence terms
  and made the final call. Treat as **UNVERIFIED for release purposes** until someone does.

---

## Deck crew figure (`crew-01`)

| field | value |
|---|---|
| asset | `packages/assets-pipeline/raw/bikini_girl.glb` → `apps/client/public/models/crew/crew-01.lod{0,1}.glb` |
| title | "Bikini girl" |
| author | doublesob ([sketchfab.com/ssorpeg](https://sketchfab.com/ssorpeg)) |
| source | <https://sketchfab.com/3d-models/bikini-girl-95aba54a1796409ea85285c5a841b9a5> |
| licence (as recorded) | CC-BY-4.0 (<http://creativecommons.org/licenses/by/4.0/>) |
| commercial use | Permitted under CC-BY-4.0, **conditional on attribution**. |
| **status** | **LIKELY OK, NOT YET CONFIRMED BY A HUMAN — must be confirmed before any public/Steam release.** |

### Why this isn't marked CONFIRMED

The licence/author/source fields above were **not manually typed in by a human reviewer** — they
were extracted two ways, which agree with each other but are still both automated:

1. The GLB's own `asset.extras` block (readable with any glTF/JSON viewer) embeds:
   `{"author":"doublesob (https://sketchfab.com/ssorpeg)","license":"CC-BY-4.0 (...)","source":"https://sketchfab.com/3d-models/bikini-girl-95aba54a1796409ea85285c5a841b9a5","title":"Bikini girl"}`.
2. An automated fetch of the live Sketchfab page (2026-10-03) returned the same licence
   ("CC Attribution") and the same author handle.

That agreement is reassuring but **does not substitute for a human reading Sketchfab's actual
licence terms and this project's own attribution requirements** — metadata can be wrong, pages
change, and "CC-BY" has specific attribution-format obligations (credit text, link-back) that
need to actually be implemented somewhere (credits screen / README) before this is shippable.

**TODO before any public/Steam build:**
1. A human opens the source URL above and confirms the licence shown is still CC-BY-4.0.
2. Add the required attribution ("Bikini girl" by doublesob, CC-BY-4.0, link to the Sketchfab
   page) to the game's credits screen — CC-BY requires attribution to remain discoverable by end
   users, not just in a repo doc.
3. Re-run this check for every additional crew figure/texture added later — each one gets its own
   row in this table, not a blanket assumption that "the pipeline already checked licences."
4. The two textures (`baseColorTexture`, `normalTexture`) ship inside the same GLB and are
   assumed to be covered by the same Sketchfab licence grant as the mesh (that's the normal case
   for a single-model Sketchfab upload) — not independently verified.

### Technical notes

- Not rigged: `skins: 0, animations: 0` in the source file. Static pose only — see
  `apps/client/src/entities/crew-model/index.ts` for what adding a rigged+animated version later
  requires.
- Original: glTF 2.0, Sketchfab-17.3.0 export, 49,860 triangles, 1 mesh / 1 material / 2 textures
  (1024×1024 baseColor + normal, PNG), 4.71 MB.
- Pipeline output (see `packages/assets-pipeline/scripts/build-crew.sh` and this project's
  report for exact numbers): two LODs, simplified with `@gltf-transform/cli` (meshoptimizer
  simplifier) + meshopt geometry compression + WebP textures. KTX2/Basis was tried first and built
  cleanly (valid glTF, `gltf-transform validate` reported zero errors), but its Basis transcoder
  runs inside a Web Worker and that worker's WASM init never completed in this project's
  sandboxed/software-WebGL test environment — figures loaded with zero errors but never visually
  appeared. WebP has no such runtime dependency and, empirically, compressed *smaller* for this
  asset besides. See `build-crew.sh`'s header for the full explanation.

### Mixamo animation (not used by this pipeline)

`Hip Hop Dancing.fbx` (in the user's Downloads, not copied into this repo) is a Mixamo library
animation with a standard `mixamorig:` skeleton. Mixamo's own licence (free for use, including
commercial, per Adobe's Mixamo ToS as of this writing — **also not independently confirmed by a
human on this team**) is separate from the character model's CC-BY licence above and would need
its own row here if/when it's actually brought into the repo.

---

## Dancing deck crew figure (`dance-01`) — bikini_girl rigged to the Mixamo skeleton

| field | value |
|---|---|
| asset | `packages/assets-pipeline/raw/bikini_girl.glb` + `packages/assets-pipeline/raw/hiphop_dancing.fbx` → `apps/client/public/models/crew/dance-01.glb` (+ `dance-01.lod1.glb`) |
| what it is | A **derived/combined asset**: the realistic "Bikini girl" Sketchfab mesh (see the `crew-01` entry above for its own provenance) bound, locally in Blender, to Mixamo's `mixamorig:` skeleton and "Hip Hop Dancing" animation clip — i.e. the same outcome Mixamo's own web auto-rigger produces, done with Blender's heat-map "Automatic Weights" instead. |
| mesh provenance | "Bikini girl" by doublesob ([sketchfab.com/ssorpeg](https://sketchfab.com/ssorpeg)), <https://sketchfab.com/3d-models/bikini-girl-95aba54a1796409ea85285c5a841b9a5>, **CC-BY-4.0 — attribution required**. Same licence terms and same NOT-YET-CONFIRMED-BY-A-HUMAN status as the `crew-01` entry above (this is the identical source mesh, just rigged instead of static) — see that entry's "Why this isn't marked CONFIRMED" section, which applies here too. |
| animation/skeleton provenance | Mixamo (Adobe) "Hip Hop Dancing" library animation + standard `mixamorig:` skeleton, from `raw/hiphop_dancing.fbx`. Adobe Mixamo general terms of use (free for personal and commercial use, no attribution required, as of this writing) — **NOT CONFIRMED BY A HUMAN**, same as before. |
| **status** | **LIKELY OK, NOT YET CONFIRMED BY A HUMAN for either provenance — must be confirmed before any public/Steam release.** Because this ships the mesh, CC-BY-4.0's attribution requirement applies to this asset exactly as it does to `crew-01`: the same "Bikini girl" / doublesob / link-back credit is needed on the game's credits screen (not yet implemented — see `crew-01`'s TODO list above, which now also covers this asset). |

### History — this superseded a different, stand-in character

Earlier, this file shipped Mixamo's own generic "X Bot" mannequin (`hiphop_dancing.fbx`'s *own*
embedded mesh, `Beta_Surface` — a flat reddish-brown, textureless stand-in Mixamo bundles with
every "with skin" library export) dancing, while the textured `bikini_girl` figure stood around
statically elsewhere on the same boats. That was flagged at the time as temporary — see this
task's report for the rigging work that replaced it with the actual bind described above.

### Technical notes

- Rigging: `packages/assets-pipeline/scripts/rig-dancer.blender.py` (Blender 5.2, headless).
  Imports both raw assets, aligns scale (bikini_girl is unit-height in its raw export; the Mixamo
  rig is real-world metres) and pose (bikini_girl's rest pose has both arms raised to her hair, not
  Mixamo's T-pose — the rig's arm chain is bent in pose-space to roughly match before binding),
  merges 11,686 duplicate/overlapping vertices in the Sketchfab mesh (without this, non-manifold
  edges and 1,335 disconnected geometry islands make Blender's heat-weight solver fail on the
  ENTIRE mesh — not a partial/warned failure, confirmed as zero weighted vertices on every one of
  65 vertex groups), disables deform on the 40 Mixamo finger bones (no separated finger geometry
  on this mesh for them to own), binds with Blender's "Automatic Weights", re-attaches the
  original action, and exports a single full-resolution (49,860-tri) rigged + animated GLB.
- **Known limitation**: Mixamo's generic bone-chain lengths are not rescaled to bikini_girl's
  actual limb proportions (only rotated into her rest pose, never resized). Combined with
  replaying the original T-pose-authored animation against a hand-bent rest pose (a standard but
  not mathematically exact technique for an A/T-pose rest mismatch), this shows up as
  visible-but-bounded arm elongation on the dance's biggest reach beats. It is **not** torn,
  collapsed, or exploded geometry — judged by rendering the bind across the full ~7 s clip in
  Blender, not guessed at. See `apps/client/test/screenshots/crew-rigged/` for that render and
  this task's report for the full honest call.
- Build pipeline (`packages/assets-pipeline/scripts/build-dance.sh`): the Blender rig step above,
  then `gltf-transform optimize` twice (near/far LOD) with meshopt geometry+animation compression
  and WebP textures (1024px near / 384px far, matching `crew-01`'s texture-size split).
  **Simplify is enabled** for both LODs — unlike the previous build (which disabled it as
  "not confirmed safe on a skinned character"), this was directly tested: pre- vs post-simplify
  dance frames rendered in Blender are visually identical in pose/deformation, just lower-poly.
  `gltf-transform validate` reports zero errors on both outputs (same benign
  `NODE_SKINNED_MESH_NON_ROOT` warning as before, plus an expected `UNSUPPORTED_EXTENSION` notice
  for `EXT_meshopt_compression`, which the official validator doesn't recognise but every target
  loader does).
- Sizes: near LOD 11,964 tris / 523.9 KB (`dance-01.glb`, what the game loads); far LOD 5,222 tris
  / 255.0 KB (`dance-01.lod1.glb`, built but not yet wired to runtime LOD switching — same status
  as `crew-01.lod{0,1}.glb`). Source mesh was 49,860 tris / 4.71 MB. Previous (X-Bot) `dance-01.glb`
  was 174.5 KB with no textures at all; the size increase is the textures this asset now actually
  carries (baseColor + normal, WebP), not bloat — X-Bot never had any.
