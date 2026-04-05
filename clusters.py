def list_clusters(w):
    return [
        {"id": c.cluster_id, "name": c.cluster_name, "state": c.state.value}
        for c in w.clusters.list()
    ]


def start_cluster(w, cluster_id):
    w.clusters.start(cluster_id)
    return {"status": "starting", "cluster_id": cluster_id}


def stop_cluster(w, cluster_id):
    w.clusters.delete(cluster_id)
    return {"status": "terminating", "cluster_id": cluster_id}
