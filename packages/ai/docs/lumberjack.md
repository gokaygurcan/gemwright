# Lumberjack

[Documentation index](README.md)

The lumberjack (`lumberjack.ts`, template `britain-lumberjack`: Lumberjacking 50, Carpentry 50, Britain) reuses the shared navigation, mounts, banking, conversation, and population infrastructure. New characters start with a hatchet in hand (`CharacterCreation.cs`).

## Best value from wood

Applying the miner's analysis to the pinned shard's vendors and recipes:

- Logs sell for 1 gold. Boards are a vendor economy item (75% of the carpenter's 3-gold price): **2 gold each**.
- Using a hatchet on a log pile turns every log into a board (`Log.Axe`, no skill check), halving the weight (logs 2 stones, boards 1).
- No carpentry product beats selling its boards (best: wooden box, 0.70 gold per board). Bows beat boards only from about Bowcraft 65 (a bow is 7 boards for 17 gold); composite bows and crossbows need 60–110. A future bowyer build could use them.

So the lumberjack cuts logs into boards whenever the pack passes 70% weight, sells boards to Britain's carpenter (1430, 1597) when even boards fill the pack, banks the gold, and buys a replacement hatchet (60 gold limit, bank-charged) from the blacksmith.

## Chopping

Trees are the 149 statics of `Lumberjacking.cs` `m_TreeTiles`. The home woods are west of Britain around (1230, 1470), the densest stand near town that is not the cemetery; each lumberjack's temperament shifts its favourite stand by up to 30 tiles. Trees within 40 tiles are ranked by distance, closeness to that stand, and whether someone is already working nearby. The lumberjack dismounts and chops the tree until it has no wood left (`lumber-chop.ts`), then moves to the next one in sight. Logs are cut into boards (half the weight) at 70% weight or a full pack, and chopping goes on until even boards fill the pack (92% weight or 117 of the backpack's 125 items, `inventory.ts`); now and then, by chaos, a lumberjack stops earlier. A full load is sold at the market or the carpenter, sometimes partly made into furniture first (Carpentry), and what no one buys is banked. Each swing reads `Lumberjacking.cs` replies: logs (AOS `1072540–1072546` or `500498`), a failed chop (`500495`), depleted or too far (`500493`, `500446`), pack full (`500497`), and a broken axe (`500499`). Depleted trees are remembered for 30 minutes (respawn 20–30 minutes) in the shared depletion list. Unreachable trees are skipped. A tree that never answers with wood or a miss is set aside like a depleted one, and unexpected replies are logged.

Chopping, cutting boards and the carpenter sale still await a long enough live run.
