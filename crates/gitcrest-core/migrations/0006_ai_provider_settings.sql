CREATE TABLE ai_provider_settings (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT INTO ai_provider_settings (singleton_id, provider, base_url, model, updated_at_ms)
VALUES (1, 'none', '', '', 0);
