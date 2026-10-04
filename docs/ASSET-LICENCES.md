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

## Dancing deck crew figure (`dance-01`)

| field | value |
|---|---|
| asset | `packages/assets-pipeline/raw/hiphop_dancing.fbx` → `apps/client/public/models/crew/dance-01.glb` |
| title | "Hip Hop Dancing" (Mixamo animation) on Mixamo's default "X Bot" character mesh |
| author | Mixamo (Adobe) |
| source | Mixamo library (mixamo.com) — exact download date not recorded; file was already present in the user's Downloads when this task started |
| licence (as recorded) | Adobe Mixamo general terms of use (free for personal and commercial use, no attribution required, as of this writing) |
| commercial use | Believed permitted under Mixamo's ToS. |
| **status** | **NOT CONFIRMED BY A HUMAN — a human must read Adobe's current Mixamo ToS before any public/Steam release.** |

### IMPORTANT — this is a different, stand-in character, not the bikini_girl crew rigged

The above superseded entry ("Mixamo animation (not used by this pipeline)") assumed this file
would eventually be used to *animate* the existing `bikini_girl` crew figure, once the user ran
that mesh through Mixamo's own auto-rigger. **That has not happened.** Direct inspection of the
FBX (its embedded strings, e.g. `...Dropbox (Adobe)\Mixamo\Characters\X Bot\clean.ma`, and its
mesh name `Beta_Surface`/`Beta_Joints`) confirms this is a Mixamo **"with skin"** library export:
it ships Mixamo's own generic default character ("X Bot") complete with its own mesh and
skeleton, not a rigged version of this project's bikini_girl model. The two don't look alike —
X Bot is a flat reddish-brown, textureless mannequin (Mixamo didn't export a diffuse texture for
it); bikini_girl is the textured Sketchfab figure above.

**This means the game currently ships two different-looking crew figures**: the static,
non-dancing `bikini_girl` (used wherever `entities/crew-model/asset.ts` still points at it) and
this rigged, dancing X Bot. Whoever owns this next should decide whether to:
1. Keep X Bot as the permanent dancing figure (simplest — it already works end to end), or
2. Get the user to actually run `bikini_girl.glb` through Mixamo's auto-rigger (producing a new
   FBX/glTF with the *bikini_girl mesh* bound to a `mixamorig:` skeleton) and re-point this same
   pipeline at that file instead — the rest of the pipeline below (strip/prune/optimize) and the
   `entities/crew-model/` runtime code should need little to no change, since it already expects
   a generic `mixamorig:`-skeleton + single animation clip shape.

This was flagged rather than silently decided — see this task's report for the same note.

### Technical notes

- Source FBX: Kaydara FBX binary v7700, 2.2 MB, 1 mesh ("Beta_Surface", ~28k triangles / 14.3k
  vertices after welding) + skeleton (`mixamorig:` naming, ~65 joints) + 1 animation
  (`mixamo.com`, 7 s / originally 8,500 keyframes). A second mesh+skin ("Beta_Joints") ships in
  the same file — Mixamo's own joint-visualization overlay for its rig preview, not part of the
  character — and is dropped by the pipeline (see below).
- No textures: the FBX's material (`Beta_HighLimbsGeoSG3`) is a flat PBR colour
  (`baseColorFactor` ≈ `[0.67, 0.24, 0.21]`, a reddish-brown "skin" tone), not an image texture.
  This is why X Bot renders as a flat mannequin colour rather than a textured character.
- Pipeline (`packages/assets-pipeline/scripts/build-dance.sh`): FBX2glTF (native binary, the
  `fbx2gltf` npm devDependency — see `packages/assets-pipeline/package.json`) → strip the
  `Beta_Joints` node (`scripts/strip-mesh-node.cjs`) → `gltf-transform prune` → `gltf-transform
  optimize` with meshopt geometry+animation compression and **simplify/flatten/join/instance all
  disabled** (meshoptimizer's mesh simplifier and gltf-transform's scene-flattening/joining are
  not confirmed safe on a skinned+animated character by this team; rather than risk a silently
  broken skin, this ships at native resolution). Result: 2.06 MB → 174.5 KB, `gltf-transform
  validate` reports zero errors (one benign `NODE_SKINNED_MESH_NON_ROOT` warning, standard for
  this export shape). No KTX2/WebP step — there are no textures to compress.
- No distant/cheap LOD: unlike `crew-01`'s two-LOD split, this asset ships as a single ~28k-tri
  mesh at every distance (see `entities/crew-model/asset.ts`'s header for where a decimated,
  skin-safe LOD1 would plug in later — deferred, not forgotten).
