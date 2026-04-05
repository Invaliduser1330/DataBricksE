def list_jobs(w):
    return [
        {"id": j.job_id, "name": j.settings.name}
        for j in w.jobs.list()
    ]


def run_job(w, job_id):
    run = w.jobs.run_now(job_id=int(job_id))
    return {"run_id": run.run_id, "status": "triggered"}


def list_runs(w):
    return [
        {"run_id": r.run_id, "job_id": r.job_id,
         "state": r.state.life_cycle_state.value if r.state else "unknown"}
        for r in w.jobs.list_runs()
    ]
