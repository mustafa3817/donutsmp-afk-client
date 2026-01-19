# Mobilde (Termux) Nasıl Çalıştırılır?

Bu dosyaları arkadaşlarınıza gönderip onların da telefonda (Android) çalıştırmasını sağlamak için yapmanız gerekenler:

## Yöntem 1: Dosyaları Göndererek (En Kolay)
1. Bu klasörün içindeki **tüm dosyaları** (sadece `node_modules` hariç) arkadaşlarınıza WhatsApp, Telegram veya Discord üzerinden gönderin (zipleyip atabilirsiniz).
2. Arkadaşınız **Termux** uygulamasını Google Play Store veya F-Droid'den indirmeli.
3. Dosyaları telefonunda bir klasöre çıkarmalı.
4. Termux'u açıp o klasöre gitmeli (Örn: `cd /storage/emulated/0/Download/BotKlasoru`).
5. Şu komutu yazmalı:
   ```bash
   bash termux_install.sh
   ```
6. Bittikten sonra `npm start` yazarak başlatabilir.

---

## Yöntem 2: GitHub Kullanarak (Daha Profesyonel)
Eğer bu projeyi GitHub'a yüklerseniz, arkadaşlarınız tek bir kod satırı ile her şeyi kurabilir.

1. Bu projeyi kendi GitHub hesabınıza yükleyin (Repo oluşturun ve dosyaları atın).
2. Arkadaşınıza şu "Tek Satır Komutu" verin (Kendi kullanıcı adınızı düzenleyin):

```bash
pkg install git -y && git clone https://github.com/mustafa3817/donutsmp-afk-client.git && cd donutsmp-afk-client && bash termux_install.sh
```

Bu komut her şeyi (git, nodejs, bot dosyaları, kütüphaneler) otomatik indirip kuracaktır.
