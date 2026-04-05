from databricks.sdk.service.workspace import ExportFormat


def list_notebooks(w, path):
    return [
        {"path": obj.path, "type": obj.object_type.value}
        for obj in w.workspace.list(path)
    ]


def export_notebook(w, path):
    content = w.workspace.export(path, format=ExportFormat.SOURCE)
    return {"path": path, "content": content.content}
