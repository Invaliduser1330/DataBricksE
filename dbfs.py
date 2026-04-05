def list_files(w, path):
    return [
        {"path": f.path, "is_dir": f.is_dir, "size": f.file_size}
        for f in w.dbfs.list(path)
    ]


def delete_file(w, path):
    w.dbfs.delete(path, recursive=False)
    return {"deleted": path}
