ビルド済みのObsidian HTMLプラグインです。利用時のNode.jsインストールやビルドは不要です。

## 1.0.1の修正

画像埋め込み `![[image.png]]` の直後に改行して記述した斜体・太字・リンクが、正しくHTMLへ変換されるようになりました。画像のサイズ指定にも対応しています。

## インストール

1. Assetsから `obsidian-html-X.Y.Z.zip` をダウンロードして展開します（Source codeのZIPではありません）。
2. 展開した `obsidian-html` フォルダーを、Vaultの `.obsidian/plugins/` にコピーします。`main.js`・`manifest.json`・`templates/` がすべて含まれていることを確認してください。
3. Obsidianを再起動して、「設定 → コミュニティプラグイン」で **Obsidian HTML** を有効にします。

更新時は、Obsidianを終了してから既存のプラグインフォルダーにファイルを上書きし、再起動してください。

デスクトップ版Obsidian 1.5.0以上に対応しています。詳しい使い方はリポジトリのREADMEをご覧ください。
