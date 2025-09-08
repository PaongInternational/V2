const { IncomingForm } = require('formidable');
const JSZip = require('jszip');
const { createClient } = require('@supabase/supabase-js');
const { promises: fs } = require('fs');
const path = require('path');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        const form = new IncomingForm();
        
        const [fields, files] = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) return reject(err);
                resolve([fields, files]);
            });
        });

        const zipFile = files.zipFile[0];
        const projectName = fields.projectName[0];
        
        if (!zipFile || !projectName) {
            return res.status(400).json({ message: 'Nama proyek dan file ZIP harus diunggah.' });
        }

        // Baca dan ekstrak file ZIP
        const zipData = await fs.readFile(zipFile.filepath);
        const zip = await JSZip.loadAsync(zipData);
        
        // Ambil semua file dari ZIP dan ubah ke format yang bisa diterima Vercel
        const vercelFiles = await Promise.all(
            Object.keys(zip.files).map(async (fileName) => {
                const zipEntry = zip.files[fileName];
                if (zipEntry.dir) {
                    return null; // Abaikan direktori
                }
                
                const fileContent = await zipEntry.async('base64');
                
                return {
                    file: fileName,
                    data: fileContent,
                    encoding: 'base64',
                };
            }).filter(Boolean)
        );

        // Cek apakah ada file yang valid
        if (vercelFiles.length === 0) {
            return res.status(400).json({ message: 'File ZIP kosong atau tidak berisi file yang valid.' });
        }

        // Deploy ke Vercel dengan API
        const vercelToken = process.env.VERCEL_TOKEN;
        if (!vercelToken) {
            return res.status(500).json({ message: 'Token Vercel tidak ditemukan.' });
        }

        const vercelResponse = await fetch('https://api.vercel.com/v13/deployments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${vercelToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: projectName,
                files: vercelFiles,
            }),
        });

        const vercelData = await vercelResponse.json();
        if (!vercelResponse.ok) {
            throw new Error(`Vercel deployment gagal: ${JSON.stringify(vercelData)}`);
        }

        const deploymentUrl = `https://${vercelData.alias[0]}`;
        
        // Simpan data ke database Supabase
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        const { error: dbError } = await supabase
            .from('projects')
            .insert({
                // Ini akan diperbaiki di masa depan dengan user ID yang benar
                user_id: 'some-user-id',
                name: projectName,
                deployment_url: deploymentUrl,
                vercel_project_id: vercelData.id,
            });

        if (dbError) {
            console.error('Gagal menyimpan ke database:', dbError);
        }

        return res.status(200).json({ message: 'Deployment berhasil!', url: deploymentUrl });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Terjadi kesalahan internal.', error: err.message });
    }
};
