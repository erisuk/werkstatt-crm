#!/bin/zsh
# Legt einmalig das Zertifikat „Zentrale Signatur“ im Anmelde-Schlüsselbund an.
# Damit erkennt macOS die Zentrale an diesem Zertifikat statt am Fingerabdruck des Programms – Erlaubnisse für
# Kalender, Erinnerungen und den Schlüsselbund bleiben dann auch nach jedem Neubau bestehen.
# Nur /usr/bin/codesign darf den Schlüssel benutzen. Kein Admin-Passwort, keine Systemeinstellung.
set -euo pipefail
NAME="Zentrale Signatur"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
  echo "„$NAME“ gibt es schon – nichts zu tun."
  exit 0
fi

TMP=$(mktemp -d)
cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
PASS=$(openssl rand -hex 16) # nur für die Übergabe an den Schlüsselbund, wird nirgends gespeichert
openssl req -x509 -newkey rsa:3072 -nodes -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 3650 -config "$TMP/cert.cnf" 2>/dev/null
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout "pass:$PASS" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout "pass:$PASS"
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
# Schlüssel-Dateien nicht herumliegen lassen (Papierkorb statt endgültig löschen).
mv "$TMP" "$HOME/.Trash/zentrale-zertifikat-$(date +%s)"
security find-identity -p codesigning "$KEYCHAIN" | grep "\"$NAME\""
echo "Fertig: „$NAME“ liegt im Anmelde-Schlüsselbund."
