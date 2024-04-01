import styles from './text.module.css'
import ReactMarkdown from 'react-markdown'
import YouTube from 'react-youtube'
import gfm from 'remark-gfm'
import { LightAsync as SyntaxHighlighter } from 'react-syntax-highlighter'
import atomDark from 'react-syntax-highlighter/dist/cjs/styles/prism/atom-dark'
import mention from '@/lib/remark-mention'
import sub from '@/lib/remark-sub'
import React, { useState, memo, useRef, useCallback, useMemo, useEffect } from 'react'
import GithubSlugger from 'github-slugger'
import LinkIcon from '@/svgs/link.svg'
import Thumb from '@/svgs/thumb-up-fill.svg'
import { toString } from 'mdast-util-to-string'
import copy from 'clipboard-copy'
import ZoomableImage, { decodeOriginalUrl } from './image'
import { IMGPROXY_URL_REGEXP, parseInternalLinks } from '@/lib/url'
import reactStringReplace from 'react-string-replace'
import { rehypeInlineCodeProperty } from '@/lib/md'
import { Button } from 'react-bootstrap'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { UNKNOWN_LINK_REL } from '@/lib/constants'
import isEqual from 'lodash/isEqual'
import { gql, useLazyQuery } from '@apollo/client'

export function SearchText ({ text }) {
  return (
    <div className={styles.text}>
      <p className={styles.p}>
        {reactStringReplace(text, /\*\*\*([^*]+)\*\*\*/g, (match, i) => {
          return <mark key={`strong-${match}-${i}`}>{match}</mark>
        })}
      </p>
    </div>
  )
}

// this is one of the slowest components to render
export default memo(function Text ({ rel, imgproxyUrls, children, tab, itemId, outlawed, topLevel, noFragments }) {
  const [overflowing, setOverflowing] = useState(false)
  const router = useRouter()
  const [show, setShow] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    setShow(router.asPath.includes('#'))
    const handleRouteChange = (url, { shallow }) => {
      setShow(url.includes('#'))
    }

    router.events.on('hashChangeStart', handleRouteChange)

    return () => {
      router.events.off('hashChangeStart', handleRouteChange)
    }
  }, [router])

  useEffect(() => {
    const container = containerRef.current
    if (!container || overflowing) return

    function checkOverflow () {
      setOverflowing(container.scrollHeight > window.innerHeight * 2)
    }

    let resizeObserver
    if (!overflowing && 'ResizeObserver' in window) {
      resizeObserver = new window.ResizeObserver(checkOverflow).observe(container)
    }

    window.addEventListener('resize', checkOverflow)
    checkOverflow()

    return () => {
      window.removeEventListener('resize', checkOverflow)
      resizeObserver?.disconnect()
    }
  }, [containerRef.current, setOverflowing])

  const slugger = new GithubSlugger()

  const Heading = useCallback(({ children, node, ...props }) => {
    const [copied, setCopied] = useState(false)
    const nodeText = toString(node)
    const id = useMemo(() => noFragments ? undefined : slugger?.slug(nodeText.replace(/[^\w\-\s]+/gi, '')), [nodeText, noFragments, slugger])
    const h = useMemo(() => {
      if (topLevel) {
        return node?.TagName
      }

      const h = parseInt(node?.tagName?.replace('h', '') || 0)
      if (h < 4) return `h${h + 3}`

      return 'h6'
    }, [node, topLevel])
    const Icon = copied ? Thumb : LinkIcon

    return (
      <span className={styles.heading}>
        {React.createElement(h || node?.tagName, { id, ...props }, children)}
        {!noFragments && topLevel &&
          <a className={`${styles.headingLink} ${copied ? styles.copied : ''}`} href={`#${id}`}>
            <Icon
              onClick={() => {
                const location = new URL(window.location)
                location.hash = `${id}`
                copy(location.href)
                setTimeout(() => setCopied(false), 1500)
                setCopied(true)
              }}
              width={18}
              height={18}
              className='fill-grey'
            />
          </a>}
      </span>
    )
  }, [topLevel, noFragments, slugger.current])

  const Table = useCallback(({ node, ...props }) =>
    <span className='table-responsive'>
      <table className='table table-bordered table-sm' {...props} />
    </span>, [])

  const Code = useCallback(({ node, inline, className, children, style, ...props }) => {
    return inline
      ? (
        <code className={className} {...props}>
          {children}
        </code>
        )
      : (
        <SyntaxHighlighter style={atomDark} language='text' PreTag='div' {...props}>
          {children}
        </SyntaxHighlighter>
        )
  }, [])

  const P = useCallback(({ children, node, ...props }) => <div className={styles.p} {...props}>{children}</div>, [])

  const A = useCallback(({ node, href, children, ...props }) => {
    const [embedString, setEmbedString] = useState('')

    const url = new URL(href)
    const { pathname, searchParams } = url
    const emptyPart = part => !!part
    const parts = pathname.split('/').filter(emptyPart)
    const queryParams = {}
    searchParams.forEach((value, key) => {
      if (!queryParams[key]) {
        queryParams[key] = [value]
      } else {
        queryParams[key].push(value)
      }
    })

    const [fetchDocument] = useLazyQuery(gql`
    query FetchDocument($url: String!) {
      fetchDocument(url: $url)
    }
  `)

    useEffect(() => {
      if ((url.host === 'rumble.com' && parts[0] !== 'embed') || (url.host === 'peertube.tv' && parts[1] !== 'embed')) {
        try {
          fetchDocument({
            variables: { url: href },
            onCompleted: (data) => {
              setEmbedString(data?.fetchDocument)
            }
          })
        } catch (err) {
          console.error(err)
        }
      }
    }, [href])

    children = children ? Array.isArray(children) ? children : [children] : []
    // don't allow zoomable images to be wrapped in links
    if (children.some(e => e?.props?.node?.tagName === 'img')) {
      return <>{children}</>
    }

    // if outlawed, render the link as text
    if (outlawed) {
      return href
    }

    // If [text](url) was parsed as <a> and text is not empty and not a link itself,
    // we don't render it as an image since it was probably a conscious choice to include text.
    const text = children[0]
    if (!!text && !/^https?:\/\//.test(text)) {
      if (props['data-footnote-ref'] || typeof props['data-footnote-backref'] !== 'undefined') {
        return (
          <Link
            {...props}
            id={props.id && itemId ? `${props.id}-${itemId}` : props.id}
            href={itemId ? `${href}-${itemId}` : href}
          >{text}
          </Link>
        )
      }
      return (
        // eslint-disable-next-line
        <a id={props.id} target='_blank' rel={rel ?? UNKNOWN_LINK_REL} href={href}>{text}</a>
      )
    }

    try {
      const linkText = parseInternalLinks(href)
      if (linkText) {
        return <a target='_blank' href={href} rel='noreferrer'>{linkText}</a>
      }
    } catch {
      // ignore errors like invalid URLs
    }

    // if the link is to a youtube video, render the video
    const youtube = href.match(/(https?:\/\/)?((www\.)?(youtube(-nocookie)?|youtube.googleapis)\.com.*(v\/|v=|vi=|vi\/|e\/|embed\/|user\/.*\/u\/\d+\/)|youtu\.be\/)(?<id>[_0-9a-z-]+)((?:\?|&)(?:t|start)=(?<start>\d+))?/i)
    if (youtube?.groups?.id) {
      return (
        <div style={{ maxWidth: topLevel ? '640px' : '320px', paddingRight: '15px', margin: '0.5rem 0' }}>
          <YouTube
            videoId={youtube.groups.id} className={styles.youtubeContainer} opts={{
              playerVars: {
                start: youtube?.groups?.start
              }
            }}
          />
        </div>
      )
    }

    // if the link is to a rumble video, render the video
    if (url.host === 'rumble.com') {
      if (parts[0] === 'embed') {
        return (
          <div style={{ maxWidth: topLevel ? '640px' : '320px', paddingRight: '15px', margin: '0.5rem 0' }}>
            <div className={styles.youtubeContainer}>
              <iframe
                style={{ width: '100%', height: '100%' }}
                title='Rumble Video'
                allowFullScreen=''
                src={href}
                sandbox='allow-same-origin allow-scripts allow-popups'
              />
            </div>
          </div>
        )
      }
    }

    // if the link is to a peertube video, render the video
    if (url.host === 'peertube.tv') {
      return (
        (embedString || parts[1] === 'embed') && (
          <div style={{ maxWidth: topLevel ? '640px' : '320px', paddingRight: '15px', margin: '0.5rem 0' }}>
            <div className={styles.youtubeContainer}>
              <iframe
                style={{ width: '100%', height: '100%' }}
                title='PeerTube Video'
                allowFullScreen=''
                src={embedString || href}
                sandbox='allow-same-origin allow-scripts allow-popups'
              />
            </div>
          </div>
        )
      )
    }

    // if the link is to a odysee embed, render the embeded media
    if (url.host === 'odysee.com') {
      const embedURL = parts[1] && parts[1] === 'embed' ? href : url.origin + '/$/embed' + url.pathname
      return (
        <div style={{ maxWidth: topLevel ? '640px' : '320px', paddingRight: '15px', margin: '0.5rem 0' }}>
          <div className={styles.youtubeContainer}>
            <iframe
              style={{ width: '100%', height: '100%' }}
              title='Odysee Embed'
              allowFullScreen=''
              src={embedURL}
              sandbox='allow-same-origin allow-scripts allow-popups'
            />
          </div>
        </div>
      )
    }

    // assume the link is an image which will fallback to link if it's not
    return <Img src={href} rel={rel ?? UNKNOWN_LINK_REL} {...props}>{children}</Img>
  })

  const Img = useCallback(({ node, src, ...props }) => {
    const url = IMGPROXY_URL_REGEXP.test(src) ? decodeOriginalUrl(src) : src
    // if outlawed, render the image link as text
    if (outlawed) {
      return url
    }
    const srcSet = imgproxyUrls?.[url]
    return <ZoomableImage srcSet={srcSet} tab={tab} src={src} rel={rel ?? UNKNOWN_LINK_REL} {...props} topLevel />
  }, [imgproxyUrls, topLevel, tab])

  return (
    <div className={`${styles.text} ${show ? styles.textUncontained : overflowing ? styles.textContained : ''}`} ref={containerRef}>
      <ReactMarkdown
        components={{
          h1: Heading,
          h2: Heading,
          h3: Heading,
          h4: Heading,
          h5: Heading,
          h6: Heading,
          table: Table,
          p: P,
          li: props => {
            return <li {...props} id={props.id && itemId ? `${props.id}-${itemId}` : props.id} />
          },
          code: Code,
          a: A,
          img: Img
        }}
        remarkPlugins={[gfm, mention, sub]}
        rehypePlugins={[rehypeInlineCodeProperty]}
      >
        {children}
      </ReactMarkdown>
      {overflowing && !show &&
        <Button size='lg' variant='info' className={styles.textShowFull} onClick={() => setShow(true)}>
          show full text
        </Button>}
    </div>
  )
}, isEqual)
