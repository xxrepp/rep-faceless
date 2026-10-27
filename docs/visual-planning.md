# Perencanaan visual yang dapat dilanjutkan

`Buat visual` menyusun prompt, bukan membuat gambar. Kedua tombol pada Naskah dan Storyboard memakai `startVisualPlanning`. Job `visuals` menggunakan antrean yang sudah ada dengan satu request aktif, batch berurutan maksimal 12 adegan, dan pembatalan melalui `generate.cancel` yang sudah tersedia.

## Penyimpanan dan continuity

Migrasi tambahan membuat tabel `visual_plans(project_id, state_json)` dengan foreign key cascade. Migrasi lama tidak diubah dan data proyek lama tidak ditulis ulang. JSON menyimpan versi UUID, fingerprint SHA-256 input efektif, continuity plan, target berdasarkan ID klip, signature hasil per klip dan versi hasil, serta 30 diagnostik kegagalan terakhir. Status, progres, tahap/rentang, dan error menggunakan tabel jobs yang sudah ada. Completed/pending diturunkan dari target, signature hasil yang tersimpan, edit manual, dan `needsVisual`.

Continuity plan memakai seluruh naskah, sinopsis, style/instruksi efektif, deskripsi pemeran, dan prompt lama yang masih disetujui. Plan menetapkan dunia/era/teknologi, arah visual, identitas/outfit default, desain berulang, dan keadaan masuk/keluar setiap adegan. Deskripsi pemeran lama harus sama persis. Konflik disimpan dan ditampilkan; pengguna perlu memperbaiki naskah/referensi sebelum melanjutkan. Penambahan pemeran kanonis dan penyimpanan plan terjadi dalam satu transaksi sebelum batch pertama.

Setiap batch menerima seluruh naskah, sinopsis, instruksi/style, referensi kanonis, plan yang sama, nomor target tepat, dan keadaan continuity di batas batch. Prompt detail batch sebelumnya tidak ditambahkan. Respons harus mencakup tepat seluruh nomor yang diminta, berisi field wajib yang dapat digunakan, enum kamera/strength/transisi yang didukung, dan referensi kanonis yang valid. Tidak ada fallback pencocokan berdasarkan urutan. Model terpisah memeriksa continuity semantik; keputusan routing, retry, validasi struktur, dan transisi state tetap berupa kode biasa. Desain berulang baru harus ada pada plan; batch tidak boleh menambah pemeran/desain berulang sendiri.

Konteks tidak dipotong atau diringkas diam-diam. Jika provider menolak batas konteks, proses berhenti dan pengguna perlu memilih model dengan konteks lebih besar. Pemeriksaan continuity semantik juga membutuhkan satu request per batch; ini menambah biaya token dibanding satu request tanpa review.

## Resume, edit, dan perubahan input

Setiap batch beserta checkpoint signature disimpan dalam satu transaksi. Batch berikutnya yang gagal tidak membatalkan hasil terdahulu. Resume memakai plan yang sama dan meminta target yang belum selesai saja. Cancel meng-abort request/backoff, menahan hasil terlambat, dan mempertahankan transaksi yang sudah selesai. Startup recovery yang sudah ada menandai job terputus gagal; pengguna dapat memilih Lanjutkan. Job visual terakhir tetap dimuat setelah lebih dari sepuluh menit, sehingga pesan error dan tindakan pemulihan tidak hilang saat restart.

Saat job aktif, field proyek dinonaktifkan dan `saveSnapshot` menolak snapshot agar autosave dari renderer tidak menimpa batch baru. Batalkan untuk mengedit. Fingerprint diperiksa sebelum request dan sebelum commit; perubahan di luar UI sekalipun tidak dapat menerima hasil lama. Pergantian provider/model/endpoint di tengah job menghentikan hasil yang masih diproses. Provider boleh diganti untuk Resume tanpa membuat ulang plan jika input cerita tidak berubah.

Pada Start/Resume berikutnya setelah naskah, referensi/sheet, style efektif, atau instruksi efektif berubah, plan mendapat versi baru. Semua hasil otomatis yang masih identik dengan signature tersimpan ditandai usang secara konservatif: perubahan cerita dapat memengaruhi continuity jauh setelah adegan yang diedit. Hasil yang telah diedit manual dan prompt lama sebelum fitur ini dipertahankan sebagai materi yang disetujui. Perubahan override style yang tidak digunakan tidak membatalkan pekerjaan. Resume tidak mencampur hasil otomatis dari dua versi plan yang dianggap masih berlaku. `Susun ulang visual` adalah tindakan eksplisit, dengan konfirmasi yang sudah ada, untuk mengganti semua prompt; jika terputus, Resume tetap hanya menyelesaikan target tersisa dari tindakan itu.

## Retry dan diagnostik

Satu tahap/request memiliki maksimal tiga percobaan, timeout 240 detik per percobaan (mencakup negosiasi format), backoff 1,5/3 detik ditambah jitter 0–750 ms, dan batas jeda 60 detik. Retry berlaku untuk transport sementara, timeout, HTTP 408/429 dan server error yang sesuai. HTTP 400/401/403/404/413/422 dan validasi struktur berhenti tanpa retry transport otomatis. Konflik continuity memakai alur koreksi draft terbatas yang terpisah dari retry transport (lihat di bawah). Retry-After dipatuhi; bila lebih dari 60 detik, proses berhenti dengan petunjuk menunggu lalu Resume. Negosiasi format JSON tetap terpisah dan hanya berlaku pada error format yang sesuai. Retry bawaan SDK Gemini dinonaktifkan untuk request ber-signal agar tidak melipatgandakan percobaan.

Diagnostik persisten hanya berisi provider/model, tahap, rentang, nomor percobaan, waktu berlalu, HTTP status, dan kode transport/nama error. API key, header authorization, body error provider, URL endpoint, serta isi naskah tidak masuk diagnostik. Panel proyek menampilkan progres, Cancel, Lanjutkan/Coba lagi, error yang bertahan sampai ditutup atau terselesaikan, ringkasan continuity, dan diagnostik. Plan/naskah lengkap tetap disimpan dalam database proyek sebagaimana materi kerja biasa.

## Verifikasi

`node --test tests/visual-planning.cjs tests/story-instructions.cjs` menjalankan source produksi dan migrasi/transaksi SQL melalui SQLite nyata dengan provider terkontrol, tanpa API berbayar. Tes mencakup kegagalan batch lanjutan, reopen database, Resume plan yang sama, cancel, klik ganda, perubahan input/provider/referensi, edit manual, rollback, nomor adegan salah, enum/referensi salah, konflik semantik, retry/timeout/Retry-After, kedua adapter, serta kompatibilitas data lama. Node 24 menyediakan `node:sqlite` untuk tes; runtime aplikasi tetap memakai `better-sqlite3` pada Electron.

Typecheck, build, suite regresi yang relevan, dan dev harness dengan `STUDIO_USER_DATA` terpisah harus dijalankan. Mock membuktikan orkestrasi dan kontrak; kualitas continuity model serta keandalan provider langsung memerlukan pengujian live terpisah.


UI dapat diuji dengan `node scripts/check-visual-planning.cjs` setelah build. Skrip memakai Electron dan dev harness yang sudah ada, HTTP fixture lokal (port 18743, dapat diganti dengan `STUDIO_VISUAL_TEST_PORT`), serta folder data sementara. Ia memeriksa 25 adegan, kegagalan setelah batch pertama, restart, error persisten, Cancel, Resume sampai selesai, versi plan tetap sama, dan prompt manual tetap utuh; screenshot dan log disimpan ke folder sementara yang dicetak skrip. Tidak memakai kredensial atau proyek pengguna.


## Kompatibilitas respons visual

Endpoint kompatibel dapat menerima `response_format` tetapi tidak meneruskan schema ke model. Adapter juga menuliskan schema pada instruksi sistem. Batch menerima alias eksplisit `scene_number`, field visual di dalam `visual`, serta `camera.type`/`camera.strength`. Dua nilai yang berbeda pada alias yang sama ditolak; tidak ada pencocokan berdasarkan urutan. Shorthand `wardrobe: "reference"` hanya berlaku untuk karakter kanonis yang disebut, dengan outfit default dari referensi. Story/narration pada respons visual tidak pernah mengganti naskah yang sudah ditinjau.

Validasi menampilkan kode dan alasan field yang gagal. Review continuity membedakan transisi rutin yang tersirat dari kontradiksi eksplisit; perubahan aturan, desain, atau keadaan yang bertentangan tetap ditolak. Maksimal tiga alasan konflik (masing-masing 400 karakter) ditampilkan pada error proyek agar dapat diperbaiki. Alasan ini adalah materi proyek, bukan body error provider atau kredensial.


## Koreksi draft yang ditolak continuity

Jika review valid mengembalikan konflik semantik beserta alasan, workflow boleh memperbaiki batch yang sama maksimal dua kali lalu melakukan review ulang. Draft dan alasan terakhir disimpan pada `visual_plans.state_json.repair`, terpisah dari prompt klip yang disetujui. Resume setelah restart memakai feedback tersebut hanya jika nomor target dan signature baseline masih cocok; input baru atau edit manual tidak boleh memakai feedback lama. Plan, versi, naskah, referensi, dan batch terdahulu dipertahankan. Detail keadaan per adegan (termasuk sarung tangan, basah, cedera, dan transformasi) harus konsisten pada action, wardrobe, dan motion, dengan outfit sementara memakai custom wardrobe bila perlu.

Koreksi hanya dipicu kode `VISUAL_CONTINUITY` dengan daftar alasan yang valid. HTTP error, respons review rusak, nomor adegan salah, dan pembatalan tidak memicu koreksi semantik. Tiap request tetap memiliki batas timeout/retry transport sendiri. Jika dua koreksi belum lolos, job berhenti, prompt sebelumnya tetap tersimpan, dan draft/feedback tersedia untuk Resume. Koreksi menambah biaya maksimal dua request generasi dan dua review per batch yang ditolak. Draft hanya diterapkan ke klip setelah lolos validasi struktur, review continuity, dan pemeriksaan input, dalam transaksi checkpoint yang sama.


## Toggle panel status

Tombol Tampilkan detail / Sembunyikan detail melipat penjelasan, progres rinci, diagnostik, error, dan continuity plan. Status singkat serta Batalkan/Lanjutkan tetap dapat diakses. Tanpa pilihan tersimpan, proses aktif atau error menampilkan detail, sedangkan proses selesai tampil ringkas. Pilihan pengguna disimpan lokal dan bertahan setelah reload atau restart; kegagalan penyimpanan preferensi tidak menghalangi toggle.
