import { useTranslation } from "react-i18next";
import { CornerNotice } from "../components/CornerNotice";
import {
  importDialogNoteKey,
  partitionImportItems,
  type ImportItem,
} from "./importOptimize";

export function ImportProxyDialog({
  items,
  onDismiss,
}: {
  items: ImportItem[];
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { listed, checkingCount } = partitionImportItems(items);
  const noteKey = importDialogNoteKey(items);

  return (
    <CornerNotice
      title={t("import_proxy.title")}
      actionLabel={t("import_proxy.dismiss")}
      onAction={onDismiss}
    >
      {listed.length > 0 && (
        <>
          <p className="import-proxy-heading">{t("import_proxy.optimizing_heading")}</p>
          <ul className="import-proxy-list">
            {listed.map((i) => (
              <li key={i.id} className={i.status === "failed" ? "is-failed" : ""}>
                <span className="import-proxy-clip">{i.label}</span>
                <span className="import-proxy-reason">
                  {i.status === "failed"
                    ? t("import_proxy.failed")
                    : t(`import_proxy.${i.reason.key}`, { codec: i.reason.codec })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {checkingCount > 0 && (
        <p className="import-proxy-checking">
          {t("import_proxy.checking", { n: checkingCount })}
        </p>
      )}
      <p className="import-proxy-note">{t(`import_proxy.${noteKey}`)}</p>
    </CornerNotice>
  );
}
