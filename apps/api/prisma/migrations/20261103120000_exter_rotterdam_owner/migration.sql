-- Exter Rotterdam 26 was preloaded, so no import recorded its creator, and
-- as a Casual game only global admins could see it. It gets its owner, who
-- manages it and makes its game links like any Casual game's creator.
UPDATE "Game" SET "createdById" = '538811632759865374'
WHERE "gameKey" = 'exter-rotterdam-2026' AND "createdById" IS NULL;
