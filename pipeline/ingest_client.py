import requests

class IngestClient:
    def __init__(self, base_url, serial, key, timeout=30.0):
        self.base_url = base_url.rstrip("/")
        self.serial = serial
        self.key = key
        self.timeout = timeout

    def upload(self, incident_id, video_path, duration_s):
        response = requests.post(
            self.base_url + "/clip",
            headers={
                "x-device-serial": self.serial,
                "x-device-key": self.key,
            },
            json={
                "incident_id": incident_id,
                "duration_s": duration_s,
            },
            timeout=self.timeout,
        )

        response.raise_for_status()
        upload_details = response.json()
        
        with open(video_path, "rb") as video:
            upload_response = requests.put(
                upload_details["signed_url"],
                data=video,
                headers={
                    "content-type": "video/mp4",
                    "x-upsert": "true",
                },
                timeout=self.timeout,
            )

        upload_response.raise_for_status()
        return upload_details["path"]
    
    # Delivers status check to server, returns 200 if alive
    def heartbeat(self):
        response = requests.post(
            self.base_url + "/heartbeat",
            headers={
                "x-device-serial": self.serial,
                "x-device-key": self.key,
            },
            json={},
            timeout=self.timeout,
        )
        print(response.status_code)
        print(response.text)
        response.raise_for_status()
        return response.json()

    # Reports metadata of a session (Independent of clip)
    def report_session(self, session_id, started_at, ended_at, people_observed):
        response = requests.post(
            self.base_url + "/session",
            headers={
                "x-device-serial": self.serial,
                "x-device-key": self.key,
            },
            json={
                "session_id": session_id,
                "started_at": started_at,
                "ended_at": ended_at,
                "people_observed": people_observed,
                "incidents": [],
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

   



if __name__ == "__main__":
    client = IngestClient(
        base_url="https://ajlgnlkvnzdirowmbiqf.supabase.co/functions/v1/ingest",
        serial="FMDC1_01",
        key="1DIBhzkeKjS8_nFzfOwzIyB-kJtM1bwK6EDUsvQ4E3U",
    )
    print(client.heartbeat())




    
    
