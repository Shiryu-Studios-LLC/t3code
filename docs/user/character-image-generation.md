# Character image generation

Before creating a first canon reference, open **Generation identity** in the Character Kit and check the character's presentation, species, age, life stage, student classification, and visible-magic setting. These saved fields take priority over story descriptions. Missing identity fields stop the first reference before it uses the renderer.

Select a form or outfit and fill in **Exact outfit details** with its actual components, colors, and distinctive features. ShiryuGen cannot reconstruct a uniform from its name alone.

**First canon reference** mode uses identity, physical traits, outfit details, visual canon rules, and a simple Asteria courtyard in soft daylight. It supplies neutral full-body framing and a short anime style description. It excludes series lore and the series style bible. With visible magic set to **None**, magic-effect clauses are removed from the positive prompt and reinforced in the negative prompt. **Story scene** mode allows broader scene context. First references use the deterministic canon compiler directly and still pass canon validation. Story scenes can use the local AI formatter; if it fails or exceeds 10 seconds, preparation falls back to the validated deterministic prompt with a non-blocking warning.

Character generation selects a character checkpoint independently of the global image checkpoint and uses only the kit's enabled LoRAs. An explicit character checkpoint takes precedence. Known checkpoint families select their own sampler and prompting profile; unrecognized checkpoints use generic settings. Nova Anime Illustrious first references use Euler ancestral, the normal scheduler, 26 steps, and CFG 4.5.

Open **Character overrides** to **Add Character LoRA**, choose an installed file or enter its path, edit its name and weight, enable or disable it, or remove it. Select **Save character overrides** to apply edits. **Auto** combines enabled Character LoRAs with a supported Canon/Approved reference when available. **Character LoRA** requires at least one enabled association with a file path. **Canon Reference** uses the reference image without Character LoRAs. The LoRA summary shows the saved stack that will be sent for the selected strategy; global LoRAs are excluded.

Generated chat images include collapsible **Generation details** showing the actual checkpoint, profile, renderer, sampler, scheduler, seed, dimensions, steps, guidance, LoRAs, both prompts, formatter source/model, and whether formatter fallback was used. **Regenerate** reuses those inputs with a fresh seed. The single-image preview is 480 pixels tall, fits the complete image, and opens the original when clicked.

The Zero Core adaptation updates student ages to at least 18 in ShiryuGen's saved kits and copied series rules. Original source documents are unchanged. Review migrated identity fields, especially where older descriptions did not identify the character unambiguously.

A text prompt cannot guarantee exact anatomy, handedness, costume details, or apparent age in every seed. Review a result before marking it Canon. Approved reference images currently use img2img; IPAdapter and ControlNet remain unavailable until validated workflows are supported.
