-- Up Migration

-- What the trading screen needs on top of the game tables.

-- The Yahoo Finance symbol of each security ('TEVA.TA', 'BRK-B'). The full chart fetches real OHLC + volume
-- from Yahoo by this symbol; the game itself trades only on the stored open/close (D-012).
-- NULL = no chart for this security.
ALTER TABLE securities ADD COLUMN yahoo_symbol TEXT UNIQUE;

-- The English name, for the English version of the app and the chart legend.
ALTER TABLE securities ADD COLUMN name_en TEXT;

-- The player's chart settings (type, colors, indicators...), saved like the theme so they follow
-- the player to any device. Only the API writes it, and only keys it knows (PATCH /me/chart-settings).
ALTER TABLE users ADD COLUMN chart_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Down Migration

ALTER TABLE users DROP COLUMN chart_settings;
ALTER TABLE securities DROP COLUMN name_en;
ALTER TABLE securities DROP COLUMN yahoo_symbol;
