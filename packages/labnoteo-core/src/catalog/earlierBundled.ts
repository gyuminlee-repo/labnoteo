/**
 * Catalog values earlier releases bundled, by id. A vault keeps the catalog
 * copy it was first seeded with, so a field still holding one of these values
 * was not edited by the lab: "Update catalogs" may replace it, and the Korean
 * UI still translates it.
 */
export type CatalogField = 'name' | 'description' | 'category' | 'equipment' | 'software';

export const EARLIER_BUNDLED: Readonly<Record<string, Partial<Record<CatalogField, readonly string[]>>>> = {
  WB125: { name: ['Colony Picking'] },
  WT010: {
    description: [
      'This workflow runs next-generation sequencing (NGS) instruments to generate raw data (e.g., fastq files) from sequencing-ready libraries. It covers flow cell/chip loading, run setup, on-instrument QC/monitoring, and data offloading/demultiplexing. Transcriptome-scale assays (e.g., RNA-seq) are executed here once libraries have been prepared in the dedicated library preparation workflow. For Sanger sequencing, this involves preparing DNA templates and primers, performing cycle sequencing reactions, and basecalling on capillary electrophoresis equipment to generate .ab1 chromatogram files.',
    ],
  },
  WT012: {
    description: [
      'This workflow measures specific transcript levels from RNA samples using targeted assays such as RT-qPCR, qPCR, and digital PCR (ddPCR). It supports absolute (standard curve/copy number) and relative (ΔΔCt) quantification with appropriate reference genes, and enables high-throughput measurements in 96/384-well plates with automated liquid handling.',
    ],
  },
  WT015: {
    description: [
      'This workflow verifies the size and assesses the integrity of nucleic acid fragments (DNA or RNA) using electrophoretic separation techniques. Methods such as traditional agarose gel electrophoresis or capillary electrophoresis are employed to separate fragments based on size.',
    ],
  },
  WT045: {
    description: [
      'This workflow quantifies viability and cytotoxic effects in mammalian/eukaryotic cells induced by proteins, small molecules, or gene perturbations using colorimetric/fluorometric/luminescent assays (e.g., MTT/MTS/Resazurin, LDH release, ATP-based luminescence) and imaging-based markers (e.g., Annexin V/PI, caspase activity, live/dead staining).',
    ],
  },
  WT046: {
    description: [
      'This workflow measures growth inhibition and viability of microbial cells (e.g., bacteria, yeast) under treatment with compounds, proteins, or genetic perturbations. It includes OD600 growth curves/kinetics, broth microdilution for MIC/MBC determination, CFU enumeration, resazurin/ATP-based viability assays, membrane integrity dyes (e.g., PI/SYTOX), and time-kill/biofilm susceptibility when applicable.',
    ],
  },
  WT085: {
    description: [
      'This workflow screens mammalian cell cultures for mycoplasma contamination using rapid biochemical assays (e.g., ATP-based luminescence), targeted PCR/qPCR of mycoplasmal DNA, and culture-based confirmation when required. It supports routine high-throughput screening in 96/384-well formats with appropriate positive/negative controls.',
    ],
  },
  WL055: {
    description: [
      'This workflow focuses on analyzing individual cells to understand cellular heterogeneity and functional characteristics. It includes techniques such as single-cell RNA sequencing, single-cell ATAC-seq, and other omics approaches. The workflow supports the identification of rare cell populations, lineage tracing, and the study of cellular responses to various stimuli.',
    ],
  },
  WL080: {
    description: [
      'This workflow is aimed at developing models to optimize characteristics (such as activity, solubility) of target proteins by utilizing phenotypic and sequence data obtained from protein/enzyme expression and activity measurements. It includes protein structure and function analysis, leveraging pre-trained models or publicly available models (e.g., Alphafold2, Rosettafold, MPNN).',
    ],
  },
  UHW290: {
    description: [
      'High-performance liquid chromatography coupled with tandem mass spectrometry. Provides highly sensitive and selective quantification and structural information by separating components with LC and analyzing specific ions through two stages of mass analysis. Ideal for targeted analysis in complex matrices like biological fluids.',
    ],
  },
  UHW300: {
    description: [
      'Liquid chromatography coupled with mass spectrometry. Separates components using LC and identifies them based on their mass-to-charge ratio. Offers better identification than LC alone but less structural info and selectivity than LC-MS/MS. Used for general profiling.',
    ],
  },
  UHW310: {
    description: [
      'High-performance liquid chromatography. It separates, identifies, and quantifies components in a liquid mixture using high pressure and a detector such as UV-Vis. Common for routine analysis, purity checks, and QC.',
    ],
  },
  UHW330: {
    description: [
      'Gas chromatography. It separates volatile or semi-volatile compounds in their gaseous phase based on their interaction with a stationary phase. Typically uses detectors like FID or TCD. Used for analyzing volatile organic compounds, solvent purity, and flavor/fragrance profiling.',
    ],
  },
  UHW355: {
    description: [
      'Solid-Phase Extraction (SPE) system coupled with Tandem Mass Spectrometer. Combines automated SPE for sample cleanup, concentration, and matrix removal with Tandem Mass Spectrometry for highly sensitive and selective quantification.',
    ],
  },
};

/**
 * Ids added to the bundled catalogs after the first release. Only these are
 * added to a vault copy that lacks them; an older id missing from it was
 * deleted by the lab.
 */
export const ADDED_BUNDLED_IDS: readonly string[] = ['WB155', 'WB160', 'WB001', 'WT001', 'WL001'];
