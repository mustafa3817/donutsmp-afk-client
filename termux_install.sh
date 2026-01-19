#!/bin/bash

echo "=========================================="
echo "   AFK Bot - Kolay Kurulum (Termux)"
echo "=========================================="

# 1. Termux paketlerini güncelle
echo "[1/4] Paketler güncelleniyor..."
pkg update -y && pkg upgrade -y

# 2. Gerekli araçları (Node.js) kur
echo "[2/4] Node.js ve gerekli araçlar kuruluyor..."
pkg install nodejs git python make -y

# 3. Bağımlılıkları yükle (npm install)
echo "[3/4] Bot kütüphaneleri yükleniyor (biraz sürebilir)..."
npm install

# 4. Ayar Sihirbazı
if grep -q "YOUR_DISCORD_BOT_TOKEN_HERE" config.json; then
  echo ""
  echo "=========================================="
  echo "   AYAR SİHİRBAZI 🪄"
  echo "=========================================="
  echo "Botun çalışması için birkaç bilgiye ihtiyacım var."
  echo "Bunları sırasıyla yazıp Enter'a basın."
  echo ""
  
  read -p "1. Discord Bot Tokenini Yapıştırın: " TOKEN
  read -p "2. Discord Kanal ID: " CHANNEL
  read -p "3. Minecraft Email (veya Kullanıcı Adı): " USERNAME
  read -p "4. Sunucu IP (Örn: eu.donutsmp.net): " HOST

  # Bilgileri config.json dosyasına yaz
  sed -i "s|YOUR_DISCORD_BOT_TOKEN_HERE|$TOKEN|g" config.json
  sed -i "s|YOUR_DISCORD_CHANNEL_ID_HERE|$CHANNEL|g" config.json
  sed -i "s|your_email_or_username|$USERNAME|g" config.json
  sed -i "s|play.example.com|$HOST|g" config.json
  
  echo ""
  echo "✅ Ayarlar başarıyla kaydedildi!"
  echo "=========================================="
fi

echo "=========================================="
echo "   KURULUM BAŞARIYLA TAMAMLANDI! ✅"
echo "=========================================="
echo ""
echo "Botu başlatmak için şu komutu yazıp Enter'a basın:"
echo "npm start"
echo ""
echo "Not: Botu durdurmak için CTRL tuşuna basılı tutup C'ye basın."
