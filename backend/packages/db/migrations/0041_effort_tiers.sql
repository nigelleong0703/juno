-- 0041: the effort tiers are owner settings (contract 0.x). `models.fastModel` becomes the `fast` tier's model (`models.tiers.fast`) and the owner-wide
-- `models.reasoningEffort` is dropped (it overrode every tier). A tiers section that already exists is kept; a null or malformed fastModel is just dropped.
UPDATE settings
SET doc = jsonb_set(doc, '{models,tiers}', jsonb_build_object('fast', jsonb_build_object('providerId', doc #> '{models,fastModel,providerId}', 'modelId', doc #> '{models,fastModel,modelId}')), true),
    updated_at = NOW()
WHERE jsonb_typeof(doc #> '{models,fastModel}') = 'object'
  AND doc #>> '{models,fastModel,providerId}' IS NOT NULL
  AND doc #>> '{models,fastModel,modelId}' IS NOT NULL
  AND doc #> '{models,tiers}' IS NULL;

UPDATE settings
SET doc = doc #- '{models,fastModel}' #- '{models,reasoningEffort}',
    updated_at = NOW()
WHERE doc #> '{models}' ? 'fastModel' OR doc #> '{models}' ? 'reasoningEffort';
