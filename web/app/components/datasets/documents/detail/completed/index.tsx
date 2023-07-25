'use client'
import type { FC } from 'react'
import React, { memo, useEffect, useMemo, useState } from 'react'
import { HashtagIcon } from '@heroicons/react/24/solid'
import { useTranslation } from 'react-i18next'
import { useContext } from 'use-context-selector'
import { debounce, isNil, omitBy } from 'lodash-es'
import cn from 'classnames'
import { StatusItem } from '../../list'
import { DocumentContext } from '../index'
import s from './style.module.css'
import InfiniteVirtualList from './InfiniteVirtualList'
import { formatNumber } from '@/utils/format'
import Modal from '@/app/components/base/modal'
import Switch from '@/app/components/base/switch'
import Divider from '@/app/components/base/divider'
import Input from '@/app/components/base/input'
import { ToastContext } from '@/app/components/base/toast'
import type { Item } from '@/app/components/base/select'
import { SimpleSelect } from '@/app/components/base/select'
import { disableSegment, enableSegment, fetchSegments } from '@/service/datasets'
import type { SegmentDetailModel, SegmentsQuery, SegmentsResponse } from '@/models/datasets'
import { asyncRunSafe } from '@/utils'
import type { CommonResponse } from '@/models/common'
import { Edit03, XClose } from '@/app/components/base/icons/src/vender/line/general'

export const SegmentIndexTag: FC<{ positionId: string | number; className?: string }> = ({ positionId, className }) => {
  const localPositionId = useMemo(() => {
    const positionIdStr = String(positionId)
    if (positionIdStr.length >= 3)
      return positionId
    return positionIdStr.padStart(3, '0')
  }, [positionId])
  return (
    <div className={`text-gray-500 border border-gray-200 box-border flex items-center rounded-md italic text-[11px] pl-1 pr-1.5 font-medium ${className ?? ''}`}>
      <HashtagIcon className='w-3 h-3 text-gray-400 fill-current mr-1 stroke-current stroke-1' />
      {localPositionId}
    </div>
  )
}

type ISegmentDetailProps = {
  segInfo?: Partial<SegmentDetailModel> & { id: string }
  onChangeSwitch?: (segId: string, enabled: boolean) => Promise<void>
  onCancel: () => void
}
/**
 * Show all the contents of the segment
 */
export const SegmentDetail: FC<ISegmentDetailProps> = memo(({
  segInfo,
  onChangeSwitch,
  onCancel,
}) => {
  const { t } = useTranslation()

  const renderContent = () => {
    if (segInfo?.answer) {
      return (
        <>
          <div className='mb-1 text-xs font-medium text-gray-500'>QUESTION</div>
          <div className='mb-4 text-md text-gray-800'>{segInfo.answer}</div>
          <div className='mb-1 text-xs font-medium text-gray-500'>ANSWER</div>
          <div className='text-md text-gray-800'>{segInfo.content}</div>
        </>
      )
    }

    return segInfo?.content
  }

  return (
    <div className={'flex flex-col relative'}>
      <div className='absolute right-0 top-0 flex items-center'>
        <div className='flex justify-center items-center w-6 h-6 hover:bg-gray-100 rounded-md cursor-pointer'>
          <Edit03 className='w-4 h-4 text-gray-500' />
        </div>
        <div className='mx-3 w-[1px] h-3 bg-gray-200' />
        <div className='flex justify-center items-center w-6 h-6 cursor-pointer' onClick={onCancel}>
          <XClose className='w-4 h-4 text-gray-500' />
        </div>
      </div>
      <SegmentIndexTag positionId={segInfo?.position || ''} className='w-fit mt-[2px] mb-6' />
      <div className={s.segModalContent}>{renderContent()}</div>
      <div className={s.keywordTitle}>{t('datasetDocuments.segment.keywords')}</div>
      <div className={s.keywordWrapper}>
        {!segInfo?.keywords?.length
          ? '-'
          : segInfo?.keywords?.map((word: any) => {
            return <div className={s.keyword}>{word}</div>
          })}
      </div>
      <div className={cn(s.footer, s.numberInfo)}>
        <div className='flex items-center'>
          <div className={cn(s.commonIcon, s.typeSquareIcon)} /><span className='mr-8'>{formatNumber(segInfo?.word_count as any)} {t('datasetDocuments.segment.characters')}</span>
          <div className={cn(s.commonIcon, s.targetIcon)} /><span className='mr-8'>{formatNumber(segInfo?.hit_count as any)} {t('datasetDocuments.segment.hitCount')}</span>
          <div className={cn(s.commonIcon, s.bezierCurveIcon)} /><span className={s.hashText}>{t('datasetDocuments.segment.vectorHash')}{segInfo?.index_node_hash}</span>
        </div>
        <div className='flex items-center'>
          <StatusItem status={segInfo?.enabled ? 'enabled' : 'disabled'} reverse textCls='text-gray-500 text-xs' />
          <Divider type='vertical' className='!h-2' />
          <Switch
            size='md'
            defaultValue={segInfo?.enabled}
            onChange={async (val) => {
              await onChangeSwitch?.(segInfo?.id || '', val)
            }}
          />
        </div>
      </div>
    </div>
  )
})

export const splitArray = (arr: any[], size = 3) => {
  if (!arr || !arr.length)
    return []
  const result = []
  for (let i = 0; i < arr.length; i += size)
    result.push(arr.slice(i, i + size))
  return result
}

type ICompletedProps = {
  // data: Array<{}> // all/part segments
}
/**
 * Embedding done, show list of all segments
 * Support search and filter
 */
const Completed: FC<ICompletedProps> = () => {
  const { t } = useTranslation()
  const { notify } = useContext(ToastContext)
  const { datasetId = '', documentId = '' } = useContext(DocumentContext)
  // the current segment id and whether to show the modal
  const [currSegment, setCurrSegment] = useState<{ segInfo?: SegmentDetailModel; showModal: boolean }>({ showModal: false })

  const [searchValue, setSearchValue] = useState() // the search value
  const [selectedStatus, setSelectedStatus] = useState<boolean | 'all'>('all') // the selected status, enabled/disabled/undefined

  const [lastSegmentsRes, setLastSegmentsRes] = useState<SegmentsResponse | undefined>(undefined)
  const [allSegments, setAllSegments] = useState<Array<SegmentDetailModel[]>>([]) // all segments data
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState<number | undefined>()

  const onChangeStatus = ({ value }: Item) => {
    setSelectedStatus(value === 'all' ? 'all' : !!value)
  }

  const getSegments = async (needLastId?: boolean) => {
    const finalLastId = lastSegmentsRes?.data?.[lastSegmentsRes.data.length - 1]?.id || ''
    setLoading(true)
    const [e, res] = await asyncRunSafe<SegmentsResponse>(fetchSegments({
      datasetId,
      documentId,
      params: omitBy({
        last_id: !needLastId ? undefined : finalLastId,
        limit: 9,
        keyword: searchValue,
        enabled: selectedStatus === 'all' ? 'all' : !!selectedStatus,
      }, isNil) as SegmentsQuery,
    }) as Promise<SegmentsResponse>)
    if (!e) {
      setAllSegments([...(!needLastId ? [] : allSegments), ...splitArray(res.data || [])])
      setLastSegmentsRes(res)
      if (!lastSegmentsRes)
        setTotal(res?.total || 0)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (lastSegmentsRes !== undefined)
      getSegments(false)
  }, [selectedStatus, searchValue])

  const onClickCard = (detail: SegmentDetailModel) => {
    setCurrSegment({ segInfo: detail, showModal: true })
  }

  const onCloseModal = () => {
    setCurrSegment({ ...currSegment, showModal: false })
  }

  const onChangeSwitch = async (segId: string, enabled: boolean) => {
    const opApi = enabled ? enableSegment : disableSegment
    const [e] = await asyncRunSafe<CommonResponse>(opApi({ datasetId, segmentId: segId }) as Promise<CommonResponse>)
    if (!e) {
      notify({ type: 'success', message: t('common.actionMsg.modifiedSuccessfully') })
      for (const item of allSegments) {
        for (const seg of item) {
          if (seg.id === segId)
            seg.enabled = enabled
        }
      }
      setAllSegments([...allSegments])
    }
    else {
      notify({ type: 'error', message: t('common.actionMsg.modificationFailed') })
    }
  }

  return (
    <>
      <div className={s.docSearchWrapper}>
        <div className={s.totalText}>{total ? formatNumber(total) : '--'} {t('datasetDocuments.segment.paragraphs')}</div>
        <SimpleSelect
          onSelect={onChangeStatus}
          items={[
            { value: 'all', name: t('datasetDocuments.list.index.all') },
            { value: 0, name: t('datasetDocuments.list.status.disabled') },
            { value: 1, name: t('datasetDocuments.list.status.enabled') },
          ]}
          defaultValue={'all'}
          className={s.select}
          wrapperClassName='h-fit w-[120px] mr-2' />
        <Input showPrefix wrapperClassName='!w-52' className='!h-8' onChange={debounce(setSearchValue, 500)} />
      </div>
      <InfiniteVirtualList
        hasNextPage={lastSegmentsRes?.has_more ?? true}
        isNextPageLoading={loading}
        items={allSegments}
        loadNextPage={getSegments}
        onChangeSwitch={onChangeSwitch}
        onClick={onClickCard}
      />
      <Modal isShow={currSegment.showModal} onClose={() => {}} className='!max-w-[640px]'>
        <SegmentDetail segInfo={currSegment.segInfo ?? { id: '' }} onChangeSwitch={onChangeSwitch} onCancel={onCloseModal} />
      </Modal>
    </>
  )
}

export default Completed
