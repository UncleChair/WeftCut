import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addTemplate,
  listTemplates,
  type PropSpec,
  type TemplateSummary,
} from "../ipc";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Composition duration in microseconds, used as the default "insert at"
  /// time so the template appends after existing content instead of
  /// colliding at t=0.
  compositionDurationUs: number;
}

export function TemplatePicker({ onClose, onAdded, compositionDurationUs }: Props) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    listTemplates().then(
      (list) => {
        setTemplates(list);
        if (list.length > 0) setSelectedId(list[0].id);
      },
      (e) => setError(String(e)),
    );
  }, []);

  const selected = useMemo(
    () => templates?.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="template-picker">
        <header>
          <h2>{t("template_picker.heading")}</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label={t("template_picker.close")}
          >
            ✕
          </button>
        </header>

        {error && <p className="settings-error">{error}</p>}

        {templates === null ? (
          <p className="settings-status">{t("template_picker.loading")}</p>
        ) : (
          <div className="template-picker-body">
            <div className="template-picker-list">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className={
                    tpl.id === selectedId
                      ? "template-card template-card-selected"
                      : "template-card"
                  }
                  onClick={() => setSelectedId(tpl.id)}
                >
                  <span className="template-card-name">{tpl.name}</span>
                  <span className="template-card-meta">
                    {tpl.size[0]}×{tpl.size[1]} · {tpl.default_duration_s}s
                  </span>
                  <span className="template-card-id">{tpl.id}</span>
                </button>
              ))}
            </div>

            <div className="template-picker-form">
              {selected ? (
                <TemplateForm
                  key={selected.id}
                  template={selected}
                  compositionDurationUs={compositionDurationUs}
                  onSubmit={async ({ tStartUs, props }) => {
                    setError(null);
                    try {
                      await addTemplate({
                        templateId: selected.id,
                        tStartUs,
                        props,
                      });
                      await onAdded();
                      onClose();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                />
              ) : (
                <p className="settings-status">{t("template_picker.empty")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function defaultPropValue(spec: PropSpec): unknown {
  switch (spec.type) {
    case "string":
    case "color":
      return spec.default;
    case "number":
      return spec.default;
  }
}

function TemplateForm({
  template,
  compositionDurationUs,
  onSubmit,
}: {
  template: TemplateSummary;
  compositionDurationUs: number;
  onSubmit: (args: {
    tStartUs: number;
    props: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [propValues, setPropValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(template.props_schema)) {
      init[key] = defaultPropValue(spec);
    }
    return init;
  });
  const [insertAtSec, setInsertAtSec] = useState<number>(
    compositionDurationUs / 1_000_000,
  );
  const [busy, setBusy] = useState(false);

  const setProp = (key: string, value: unknown) =>
    setPropValues((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBusy(true);
    try {
      const tStartUs = Math.max(0, Math.round(insertAtSec * 1_000_000));
      await onSubmit({ tStartUs, props: propValues });
    } finally {
      setBusy(false);
    }
  };

  const propKeys = Object.keys(template.props_schema);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{t("template_picker.props_heading")}</h3>
      {propKeys.length === 0 ? (
        <p className="settings-status">{t("template_picker.no_props")}</p>
      ) : (
        propKeys.map((key) => (
          <PropField
            key={key}
            propKey={key}
            spec={template.props_schema[key]}
            value={propValues[key]}
            onChange={(v) => setProp(key, v)}
          />
        ))
      )}

      <h3>{t("template_picker.timing_heading")}</h3>
      <label className="template-picker-field">
        <span>{t("template_picker.insert_at")}</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={insertAtSec}
          onChange={(e) => setInsertAtSec(Number(e.target.value))}
        />
      </label>
      <p className="template-picker-hint">
        {t("template_picker.duration_hint", {
          seconds: template.default_duration_s,
        })}
      </p>

      <div className="template-picker-actions">
        <button type="submit" disabled={busy}>
          {busy
            ? t("template_picker.adding")
            : t("template_picker.add")}
        </button>
      </div>
    </form>
  );
}

function PropField({
  propKey,
  spec,
  value,
  onChange,
}: {
  propKey: string;
  spec: PropSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (spec.type) {
    case "string":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            maxLength={spec.max_length}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case "color":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <ColorInput
            value={typeof value === "string" ? value : spec.default}
            onChange={onChange}
          />
        </label>
      );
    case "number":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <input
            type="number"
            value={typeof value === "number" ? value : spec.default}
            min={spec.min}
            max={spec.max}
            step={
              // Step heuristic: percent-style 0..100 → 1; small ranges (0..4) → 0.1
              spec.max !== undefined && spec.max - (spec.min ?? 0) <= 10
                ? 0.1
                : 1
            }
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </label>
      );
  }
}

/// Color input that preserves any trailing alpha bits in the original default
/// even though `<input type="color">` only edits the RGB triplet. This keeps
/// captions-strip's translucent default (#000000cc) intact unless the user
/// changes the color — at which point alpha is lost. See the CSS comment in
/// `captions_strip/style.css` for the long version.
function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // `<input type="color">` returns 6-char hex. Show 6 chars to the picker;
  // the form value carries whatever the original default had.
  const rgb = value.length >= 7 ? value.slice(0, 7) : value;
  return (
    <span className="template-picker-color">
      <input
        type="color"
        value={rgb}
        onChange={(e) => onChange(e.target.value)}
      />
      <code>{value}</code>
    </span>
  );
}
